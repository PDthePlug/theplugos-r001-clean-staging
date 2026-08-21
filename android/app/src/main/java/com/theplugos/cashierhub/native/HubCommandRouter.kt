package com.theplugos.cashierhub.native

import org.json.JSONObject
import java.util.UUID

data class RoutedCommand(val events: List<HubEventDraft>, val projections: List<ProjectionWrite>)

/**
 * Initial, deliberately small operational command family. Unsupported commands
 * are rejected rather than reduced to a generic event without domain checks.
 */
class HubCommandRouter(private val database: HubDatabase) {
    fun route(command: OperationalCommand, context: VerifiedCommandContext): RoutedCommand {
        HubPayloadSafety.rejectSensitiveValues(command.payload)
        return when (command.type) {
            "order.create" -> createOrder(command, context)
            "order.status.transition" -> transitionOrder(command, context)
            else -> throw HubCommandRejectedException("Command ${command.type} is not implemented by this Hub release.")
        }
    }

    private fun createOrder(command: OperationalCommand, context: VerifiedCommandContext): RoutedCommand {
        val orderId = command.payload.requiredOrderId()
        val items = command.payload.optJSONArray("items") ?: throw HubCommandRejectedException("Order creation requires line items.")
        if (items.length() == 0) throw HubCommandRejectedException("An order must contain at least one line item.")
        if (items.length() > MAX_ORDER_LINE_ITEMS) throw HubCommandRejectedException("An order exceeds the supported line-item limit.")
        if (database.projection("orders", orderId) != null) throw HubCommandRejectedException("An order with this orderId already exists.")
        val subtotal = requiredFiniteNonNegative(command.payload, "subtotal")
        val tax = requiredFiniteNonNegative(command.payload, "tax")
        val totalAmount = requiredFiniteNonNegative(command.payload, "totalAmount")
        val paymentMethod = command.payload.optString("paymentMethod", command.payload.optString("paymentType", "")).trim()
        if (paymentMethod !in SUPPORTED_TENDER_INTENTS) {
            throw HubCommandRejectedException("Order creation requires a supported tender intent.")
        }
        val validatedItems = validateOrderItems(items)
        val calculatedSubtotal = validatedItems.subtotal
        val calculatedTax = calculateAndValidateTax(calculatedSubtotal, tax)
        val calculatedTotal = roundMoney(calculatedSubtotal + calculatedTax)
        if (!calculatedTotal.isFinite() || calculatedTotal > MAX_ORDER_TOTAL ||
            !approximatelyEqual(subtotal, calculatedSubtotal) || !approximatelyEqual(totalAmount, calculatedTotal)
        ) {
            throw HubCommandRejectedException("Order prices or totals do not match the Hub catalog calculation.")
        }

        // Rebuild the event payload from the signed catalog and verified
        // command context. Browser/task input may choose products and tender
        // intent, but it may not smuggle display names, customer data, notes,
        // tenancy, actor identities, or arbitrary fields into the ledger.
        val projection = JSONObject()
            .put("id", orderId)
            .put("orderId", orderId)
            .put("status", "PLACED")
            .put("items", validatedItems.items)
            .put("subtotal", calculatedSubtotal)
            .put("tax", calculatedTax)
            .put("totalAmount", calculatedTotal)
            .put("paymentMethod", paymentMethod)
            .put("paymentType", paymentMethod)

        return RoutedCommand(
            events = listOf(
                HubEventDraft(
                    aggregateId = orderId,
                    aggregateType = "order",
                    action = "ORDER_PLACED",
                    payload = projection
                )
            ),
            projections = listOf(ProjectionWrite("orders", orderId, projection)) + validatedItems.stockProjections
        )
    }

    private fun transitionOrder(command: OperationalCommand, context: VerifiedCommandContext): RoutedCommand {
        val orderId = command.payload.requiredOrderId()
        val nextStatus = command.payload.optString("status", "").trim()
        if (nextStatus !in setOf("PREPARING", "READY", "COLLECTED", "CANCELLED")) {
            throw HubCommandRejectedException("Order transition must specify a supported next status.")
        }
        val current = database.projection("orders", orderId)
            ?: throw HubCommandRejectedException("The order does not exist on this Hub.")
        val currentStatus = current.optString("status", "PLACED")
        val permittedTransitions = mapOf(
            "PLACED" to setOf("PREPARING", "CANCELLED"),
            "PREPARING" to setOf("READY", "CANCELLED"),
            "READY" to setOf("COLLECTED"),
            "COLLECTED" to emptySet(),
            "CANCELLED" to emptySet()
        )
        if (nextStatus !in (permittedTransitions[currentStatus] ?: emptySet())) {
            throw HubCommandRejectedException("$currentStatus cannot transition to $nextStatus.")
        }
        if (context.role == "KITCHEN_STAFF" && nextStatus !in setOf("PREPARING", "READY")) {
            throw HubCommandRejectedException("Kitchen staff can only move an order to PREPARING or READY.")
        }
        // Keep transition events minimal and derived. The existing projection
        // is local state, but there is no need to re-replicate prior order
        // fields or accept a caller's actor/tenancy metadata.
        val projection = JSONObject()
            .put("previousStatus", currentStatus)
            .put("id", orderId)
            .put("orderId", orderId)
            .put("status", nextStatus)
        val updatedOrderProjection = JSONObject(current.toString())
            .put("previousStatus", currentStatus)
            .put("id", orderId)
            .put("orderId", orderId)
            .put("status", nextStatus)

        val stockProjections = if (nextStatus == "CANCELLED") restoreStockForCancelledOrder(current) else emptyList()
        return RoutedCommand(
            events = listOf(
                HubEventDraft(
                    aggregateId = orderId,
                    aggregateType = "order",
                    action = "ORDER_STATUS_CHANGED",
                    payload = projection
                )
            ),
            projections = listOf(ProjectionWrite("orders", orderId, updatedOrderProjection)) + stockProjections
        )
    }

    private fun JSONObject.requiredOrderId(): String {
        val value = optString("orderId", optString("id", "")).trim()
        if (value.isEmpty()) throw HubCommandRejectedException("Order command requires orderId.")
        try {
            UUID.fromString(value)
        } catch (_: IllegalArgumentException) {
            throw HubCommandRejectedException("Order command requires a UUID orderId.")
        }
        return value
    }

    private fun requiredFiniteNonNegative(payload: JSONObject, name: String): Double {
        if (!payload.has(name)) throw HubCommandRejectedException("Order creation requires $name.")
        val value = payload.optDouble(name, Double.NaN)
        if (!value.isFinite() || value < 0 || !hasMoneyPrecision(value)) {
            throw HubCommandRejectedException("Order $name must be a finite non-negative currency amount.")
        }
        return value
    }

    private fun validateOrderItems(items: org.json.JSONArray): ValidatedOrderItems {
        var subtotal = 0.0
        val normalizedItems = org.json.JSONArray()
        val stockProjections = mutableListOf<ProjectionWrite>()
        val productIds = mutableSetOf<String>()
        for (index in 0 until items.length()) {
            val item = items.optJSONObject(index) ?: throw HubCommandRejectedException("Every order line must be an object.")
            val productId = item.optString("productId", item.optString("id", "")).trim()
            if (productId.isEmpty()) throw HubCommandRejectedException("Every order line needs a productId.")
            try {
                UUID.fromString(productId)
            } catch (_: IllegalArgumentException) {
                throw HubCommandRejectedException("Every order line needs a UUID productId.")
            }
            if (!productIds.add(productId)) throw HubCommandRejectedException("An order cannot contain the same product more than once.")
            val quantity = item.optDouble("quantity", Double.NaN)
            if (!quantity.isFinite() || quantity <= 0 || quantity > MAX_LINE_QUANTITY) {
                throw HubCommandRejectedException("Order line quantity must be a supported positive finite number.")
            }
            val catalogProduct = database.projection("catalog_products", productId)
                ?: throw HubCommandRejectedException("Product $productId is not present in the Hub catalog snapshot.")
            val catalogPrice = catalogProduct.optDouble("price", Double.NaN)
            if (!catalogPrice.isFinite() || catalogPrice < 0 || !hasMoneyPrecision(catalogPrice)) {
                throw HubCommandRejectedException("Product $productId has no valid Hub price.")
            }
            val catalogName = catalogProduct.optString("name", "").trim()
            if (catalogName.isEmpty() || catalogName.length > MAX_ITEM_NAME_LENGTH) {
                throw HubCommandRejectedException("Product $productId has no valid Hub name.")
            }
            if (catalogProduct.optString("status", "").trim() != "ACTIVE") {
                throw HubCommandRejectedException("Product $productId is not active in the signed Hub catalog.")
            }
            val stockBefore = catalogProduct.optDouble("stock", Double.NaN)
            if (!stockBefore.isFinite() || stockBefore < 0 || stockBefore > MAX_STOCK_QUANTITY || !hasQuantityPrecision(stockBefore)) {
                throw HubCommandRejectedException("Product $productId has no valid Hub stock balance.")
            }
            if (!hasQuantityPrecision(quantity)) {
                throw HubCommandRejectedException("Order line quantity supports at most three decimal places.")
            }
            if (stockBefore + QUANTITY_EPSILON < quantity) {
                throw HubCommandRejectedException("Product $productId does not have enough signed Hub stock for this order.")
            }
            val stockAfter = roundQuantity(stockBefore - quantity)
            if (stockAfter < 0) throw HubCommandRejectedException("Product $productId would leave the Hub stock balance below zero.")
            val submittedPrice = item.optDouble("price", item.optDouble("unitPrice", Double.NaN))
            if (!approximatelyEqual(submittedPrice, catalogPrice)) {
                throw HubCommandRejectedException("Submitted price for $productId does not match the Hub catalog.")
            }
            subtotal = roundMoney(subtotal + roundMoney(catalogPrice * quantity))
            if (!subtotal.isFinite() || subtotal > MAX_ORDER_TOTAL) {
                throw HubCommandRejectedException("Order total exceeds the supported local limit.")
            }
            normalizedItems.put(
                JSONObject()
                    .put("productId", productId)
                    .put("name", catalogName)
                    .put("price", catalogPrice)
                    .put("quantity", quantity)
                    .put("stockBefore", stockBefore)
                    .put("stockAfter", stockAfter)
            )
            stockProjections += ProjectionWrite(
                "catalog_products",
                productId,
                JSONObject(catalogProduct.toString()).put("stock", stockAfter)
            )
        }
        return ValidatedOrderItems(subtotal, normalizedItems, stockProjections)
    }

    private fun restoreStockForCancelledOrder(current: JSONObject): List<ProjectionWrite> {
        val items = current.optJSONArray("items")
            ?: throw HubCommandRejectedException("The local order does not retain stock-reservation lines for cancellation.")
        if (items.length() == 0 || items.length() > MAX_ORDER_LINE_ITEMS) {
            throw HubCommandRejectedException("The local order has invalid stock-reservation lines.")
        }
        val productIds = mutableSetOf<String>()
        return buildList {
            for (index in 0 until items.length()) {
                val item = items.optJSONObject(index)
                    ?: throw HubCommandRejectedException("The local order has an invalid stock-reservation line.")
                val productId = item.optString("productId", "").trim()
                try {
                    UUID.fromString(productId)
                } catch (_: IllegalArgumentException) {
                    throw HubCommandRejectedException("The local order has an invalid stock-reservation product.")
                }
                if (!productIds.add(productId)) throw HubCommandRejectedException("The local order has duplicate stock-reservation products.")
                val quantity = item.optDouble("quantity", Double.NaN)
                if (!quantity.isFinite() || quantity <= 0 || !hasQuantityPrecision(quantity)) {
                    throw HubCommandRejectedException("The local order has an invalid stock-reservation quantity.")
                }
                val catalogProduct = database.projection("catalog_products", productId)
                    ?: throw HubCommandRejectedException("Product $productId is unavailable for local stock restoration.")
                val stockBefore = catalogProduct.optDouble("stock", Double.NaN)
                if (!stockBefore.isFinite() || stockBefore < 0 || stockBefore > MAX_STOCK_QUANTITY || !hasQuantityPrecision(stockBefore)) {
                    throw HubCommandRejectedException("Product $productId has an invalid local stock balance.")
                }
                val stockAfter = roundQuantity(stockBefore + quantity)
                if (!stockAfter.isFinite() || stockAfter > MAX_STOCK_QUANTITY) {
                    throw HubCommandRejectedException("Product $productId exceeds the supported local stock balance.")
                }
                add(
                    ProjectionWrite(
                        "catalog_products",
                        productId,
                        JSONObject(catalogProduct.toString()).put("stock", stockAfter)
                    )
                )
            }
        }
    }

    private fun approximatelyEqual(left: Double, right: Double): Boolean {
        if (!left.isFinite() || !right.isFinite()) return false
        return kotlin.math.abs(left - right) < MONEY_EPSILON
    }

    private fun calculateAndValidateTax(subtotal: Double, tax: Double): Double {
        val vat = database.projection("configuration", "vat")
        if (vat == null || !vat.optBoolean("enabled", false)) {
            if (!approximatelyEqual(tax, 0.0)) throw HubCommandRejectedException("The active Hub configuration does not permit tax on this order.")
            return 0.0
        }
        val rate = vat.optDouble("rate", Double.NaN)
        if (!rate.isFinite() || rate < 0 || rate > 100 || !hasMoneyPrecision(rate)) {
            throw HubCommandRejectedException("The Hub VAT configuration is invalid.")
        }
        val calculatedTax = roundMoney(subtotal * rate / 100.0)
        if (!calculatedTax.isFinite() || calculatedTax > MAX_ORDER_TOTAL || !approximatelyEqual(tax, calculatedTax)) {
            throw HubCommandRejectedException("Order tax does not match the active Hub VAT configuration.")
        }
        return calculatedTax
    }

    private fun roundMoney(value: Double): Double = Math.round(value * 100.0) / 100.0

    private fun roundQuantity(value: Double): Double = Math.round(value * 1_000.0) / 1_000.0

    private fun hasMoneyPrecision(value: Double): Boolean = value.isFinite() && kotlin.math.abs(value - roundMoney(value)) < MONEY_EPSILON

    private fun hasQuantityPrecision(value: Double): Boolean = value.isFinite() && kotlin.math.abs(value - roundQuantity(value)) < QUANTITY_EPSILON

    private data class ValidatedOrderItems(
        val subtotal: Double,
        val items: org.json.JSONArray,
        val stockProjections: List<ProjectionWrite>
    )

    private companion object {
        const val MAX_ORDER_LINE_ITEMS = 100
        const val MAX_LINE_QUANTITY = 1_000_000.0
        const val MAX_ORDER_TOTAL = 999_999_999.99
        const val MAX_STOCK_QUANTITY = 99_999_999_999.999
        const val MAX_ITEM_NAME_LENGTH = 500
        const val MONEY_EPSILON = 0.000_001
        const val QUANTITY_EPSILON = 0.000_001
        val SUPPORTED_TENDER_INTENTS = setOf("CASH", "CARD", "SPAZAPAY_QR")
    }
}
