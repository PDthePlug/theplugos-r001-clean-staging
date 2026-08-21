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
            "shift.open" -> openCashShift(command, context)
            "order.create" -> createOrder(command, context)
            "order.status.transition" -> transitionOrder(command, context)
            "payment.capture" -> captureCashPayment(command, context)
            else -> throw HubCommandRejectedException("Command ${command.type} is not implemented by this Hub release.")
        }
    }

    private fun openCashShift(command: OperationalCommand, context: VerifiedCommandContext): RoutedCommand {
        val shiftId = command.payload.requiredUuid("shiftId", "Cash shift ID")
        if (database.projection("shifts", shiftId) != null) {
            throw HubCommandRejectedException("A cash shift with this shiftId already exists on this Hub.")
        }
        if (database.activeCashShift(context.branchId) != null) {
            throw HubCommandRejectedException("This branch already has an active cash shift. Close and cash up through the approved workflow before opening another.")
        }
        val openingFloat = requiredFiniteNonNegative(command.payload, "openingFloat", "Cash shift")
        if (openingFloat > MAX_CASH_AMOUNT) throw HubCommandRejectedException("Cash shift openingFloat exceeds the supported local limit.")
        val eventPayload = JSONObject()
            .put("id", shiftId)
            .put("shiftId", shiftId)
            .put("status", "OPEN")
            .put("currency", "ZAR")
            .put("openingFloat", openingFloat)
            .put("cashSalesTotal", 0.0)
            .put("cashTenderedTotal", 0.0)
            .put("cashChangeTotal", 0.0)
            .put("expectedCash", openingFloat)
        val localProjection = JSONObject(eventPayload.toString())
            .put("businessId", context.businessId)
            .put("branchId", context.branchId)
        val openingDrawer = JSONObject()
            .put("shiftId", shiftId)
            .put("account", "CASH_DRAWER")
            .put("currency", "ZAR")
            .put("balance", openingFloat)
        return RoutedCommand(
            events = listOf(HubEventDraft(shiftId, "shift", "SHIFT_OPENED", eventPayload)),
            projections = listOf(
                ProjectionWrite("shifts", shiftId, localProjection),
                ProjectionWrite("active_cash_shift", context.branchId, localProjection),
                ProjectionWrite("financial_accounts", "${shiftId}:CASH_DRAWER", openingDrawer)
            )
        )
    }

    private fun createOrder(command: OperationalCommand, context: VerifiedCommandContext): RoutedCommand {
        val activeCashShift = database.activeCashShift(context.branchId)
            ?: throw HubCommandRejectedException("A Manager must open the branch cash shift before a Cashier can create an order.")
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
        val eventPayload = JSONObject()
            .put("id", orderId)
            .put("orderId", orderId)
            .put("status", "PLACED")
            .put("items", validatedItems.items)
            .put("subtotal", calculatedSubtotal)
            .put("tax", calculatedTax)
            .put("totalAmount", calculatedTotal)
            .put("paymentMethod", paymentMethod)
            .put("paymentType", paymentMethod)
        // Payment status is a local projection fact rather than part of the
        // R003 order-placement event. The cloud derives the same PENDING
        // state from the accepted tender intent. Keeping it out of the event
        // preserves the strict, minimal replication payload while letting the
        // local router fail closed on a later collection/cancellation request.
        val orderProjection = JSONObject(eventPayload.toString())
            .put("paymentStatus", "PENDING")
            .put("shiftId", activeCashShift.shiftId)
            .put("businessId", context.businessId)
            .put("branchId", context.branchId)

        return RoutedCommand(
            events = listOf(
                HubEventDraft(
                    aggregateId = orderId,
                    aggregateType = "order",
                    action = "ORDER_PLACED",
                    payload = eventPayload
                )
            ),
            projections = listOf(ProjectionWrite("orders", orderId, orderProjection)) + validatedItems.stockProjections
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
        requireOrderScope(orderId, current, context)
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
        enforceTransitionAuthority(context.role, currentStatus, nextStatus, current)
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
            .put("businessId", context.businessId)
            .put("branchId", context.branchId)

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

    private fun captureCashPayment(command: OperationalCommand, context: VerifiedCommandContext): RoutedCommand {
        val paymentId = command.payload.requiredUuid("paymentId", "Payment ID")
        val orderId = command.payload.requiredOrderId()
        if (database.projection("payments", paymentId) != null) {
            throw HubCommandRejectedException("A payment with this paymentId already exists on this Hub.")
        }
        val order = database.projection("orders", orderId)
            ?: throw HubCommandRejectedException("The order does not exist on this Hub.")
        requireOrderScope(orderId, order, context)
        val orderStatus = order.optString("status", "").trim()
        val paymentStatus = order.optString("paymentStatus", "PENDING").trim()
        val paymentMethod = order.optString("paymentMethod", order.optString("paymentType", "")).trim()
        if (orderStatus !in CAPTURABLE_ORDER_STATUSES || paymentStatus != "PENDING") {
            throw HubCommandRejectedException("This order is not awaiting a capturable payment.")
        }
        if (paymentMethod != "CASH") {
            throw HubUnavailableException("Only cash capture is available on this Hub release. Card and QR tender intents require a verified provider adapter.")
        }
        val activeCashShift = database.activeCashShift(context.branchId)
            ?: throw HubCommandRejectedException("A Manager must open the branch cash shift before a Cashier can capture cash.")
        val orderShiftId = order.optString("shiftId", "").trim()
        if (orderShiftId != activeCashShift.shiftId) {
            throw HubCommandRejectedException("This pending order is not bound to the active branch cash shift.")
        }
        val shiftProjection = database.projection("shifts", activeCashShift.shiftId)
            ?: throw HubCommandRejectedException("The active cash shift projection is unavailable for payment capture.")
        val amount = requiredFiniteNonNegative(order, "totalAmount", "Order")
        if (amount > MAX_CASH_AMOUNT) throw HubCommandRejectedException("Order total exceeds the supported cash-capture limit.")
        val cashTendered = requiredFiniteNonNegative(command.payload, "cashTendered", "Cash payment")
        if (cashTendered > MAX_CASH_AMOUNT || cashTendered + MONEY_EPSILON < amount) {
            throw HubCommandRejectedException("Cash tendered must cover the Hub-derived order total.")
        }
        val changeDue = roundMoney(cashTendered - amount)
        if (changeDue < 0 || changeDue > MAX_CASH_AMOUNT) throw HubCommandRejectedException("Cash change due is outside the supported local range.")
        val nextSalesTotal = roundMoney(activeCashShift.cashSalesTotal + amount)
        val nextTenderedTotal = roundMoney(activeCashShift.cashTenderedTotal + cashTendered)
        val nextChangeTotal = roundMoney(activeCashShift.cashChangeTotal + changeDue)
        val nextExpectedCash = roundMoney(activeCashShift.openingFloat + nextSalesTotal)
        if (nextSalesTotal > MAX_CASH_AMOUNT || nextTenderedTotal > MAX_CASH_AMOUNT ||
            nextChangeTotal > MAX_CASH_AMOUNT || nextExpectedCash > MAX_CASH_AMOUNT
        ) {
            throw HubCommandRejectedException("This payment would exceed the supported local cash-shift limit.")
        }

        val postings = org.json.JSONArray()
            .put(JSONObject().put("account", "CASH_DRAWER").put("debit", amount).put("credit", 0.0))
            .put(JSONObject().put("account", "ORDER_SETTLEMENT_CLEARING").put("debit", 0.0).put("credit", amount))
        val eventPayload = JSONObject()
            .put("id", paymentId)
            .put("paymentId", paymentId)
            .put("orderId", orderId)
            .put("shiftId", activeCashShift.shiftId)
            .put("tender", "CASH")
            .put("status", "CAPTURED")
            .put("currency", "ZAR")
            .put("amount", amount)
            .put("cashTendered", cashTendered)
            .put("changeDue", changeDue)
            .put("financialPostings", postings)
        val updatedOrder = JSONObject(order.toString())
            .put("paymentStatus", "CAPTURED")
            .put("paymentId", paymentId)
            .put("cashTendered", cashTendered)
            .put("changeDue", changeDue)
            .put("businessId", context.businessId)
            .put("branchId", context.branchId)
        val updatedShift = JSONObject(shiftProjection.toString())
            .put("cashSalesTotal", nextSalesTotal)
            .put("cashTenderedTotal", nextTenderedTotal)
            .put("cashChangeTotal", nextChangeTotal)
            .put("expectedCash", nextExpectedCash)
        val cashDrawer = database.projection("financial_accounts", "${activeCashShift.shiftId}:CASH_DRAWER")
        val previousDrawerBalance = cashDrawer?.optDouble("balance", activeCashShift.openingFloat) ?: activeCashShift.openingFloat
        if (!previousDrawerBalance.isFinite() || previousDrawerBalance < 0 || !hasMoneyPrecision(previousDrawerBalance)) {
            throw HubCommandRejectedException("The local cash-drawer projection is invalid.")
        }
        if (!approximatelyEqual(previousDrawerBalance, activeCashShift.expectedCash)) {
            throw HubCommandRejectedException("The local cash-drawer balance does not match the active cash-shift total.")
        }
        val nextDrawerBalance = roundMoney(previousDrawerBalance + amount)
        if (nextDrawerBalance > MAX_CASH_AMOUNT) throw HubCommandRejectedException("This payment exceeds the supported local cash-drawer limit.")
        val updatedDrawer = JSONObject()
            .put("shiftId", activeCashShift.shiftId)
            .put("account", "CASH_DRAWER")
            .put("currency", "ZAR")
            .put("balance", nextDrawerBalance)

        return RoutedCommand(
            events = listOf(HubEventDraft(paymentId, "payment", "PAYMENT_CAPTURED", eventPayload)),
            projections = listOf(
                ProjectionWrite("orders", orderId, updatedOrder),
                ProjectionWrite("payments", paymentId, eventPayload),
                ProjectionWrite("shifts", activeCashShift.shiftId, updatedShift),
                ProjectionWrite("active_cash_shift", context.branchId, updatedShift),
                ProjectionWrite("financial_accounts", "${activeCashShift.shiftId}:CASH_DRAWER", updatedDrawer)
            )
        )
    }

    private fun JSONObject.requiredOrderId(): String {
        val value = optString("orderId", optString("id", "")).trim()
        return requireUuid(value, "Order command requires orderId.")
    }

    private fun JSONObject.requiredUuid(field: String, subject: String): String {
        val value = optString(field, "").trim()
        return requireUuid(value, "$subject is required.")
    }

    private fun requireUuid(value: String, missingMessage: String): String {
        if (value.isEmpty()) throw HubCommandRejectedException(missingMessage)
        try {
            UUID.fromString(value)
        } catch (_: IllegalArgumentException) {
            throw HubCommandRejectedException("$missingMessage It must be a UUID.")
        }
        return value
    }

    private fun requiredFiniteNonNegative(payload: JSONObject, name: String, subject: String = "Order creation"): Double {
        if (!payload.has(name)) throw HubCommandRejectedException("$subject requires $name.")
        val value = payload.optDouble(name, Double.NaN)
        if (!value.isFinite() || value < 0 || !hasMoneyPrecision(value)) {
            throw HubCommandRejectedException("$subject $name must be a finite non-negative currency amount.")
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

    /** Retained local projections are not tenancy authority. New projections
     * carry their scope, while older projections are checked against their
     * immutable `ORDER_PLACED` ledger fact before any transition or capture. */
    private fun requireOrderScope(orderId: String, order: JSONObject, context: VerifiedCommandContext) {
        val projectedBusinessId = order.optString("businessId", "").trim()
        val projectedBranchId = order.optString("branchId", "").trim()
        if ((projectedBusinessId.isNotEmpty() && projectedBusinessId != context.businessId) ||
            (projectedBranchId.isNotEmpty() && projectedBranchId != context.branchId)
        ) {
            throw HubCommandRejectedException("The local order projection is outside this Hub authorization scope.")
        }
        if (!database.orderBelongsToScope(orderId, context.businessId, context.branchId)) {
            throw HubCommandRejectedException("The local order has no immutable placement event in this Hub authorization scope.")
        }
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

    /**
     * State ownership is intentionally explicit rather than inferred from a
     * broad `order.status.transition` permission. The same matrix is
     * independently enforced by the R004 cloud-ingest trigger so an older or
     * compromised Hub cannot turn a signed Cashier session into kitchen or
     * financial authority.
     */
    private fun enforceTransitionAuthority(role: String, currentStatus: String, nextStatus: String, current: JSONObject) {
        val paymentStatus = current.optString("paymentStatus", "PENDING").trim()
        val permitted = when (role) {
            "KITCHEN_STAFF" ->
                (currentStatus == "PLACED" && nextStatus == "PREPARING") ||
                    (currentStatus == "PREPARING" && nextStatus == "READY")
            "CASHIER" ->
                (currentStatus == "PLACED" && nextStatus == "CANCELLED" && paymentStatus == "PENDING") ||
                    (currentStatus == "READY" && nextStatus == "COLLECTED" && paymentStatus == "CAPTURED")
            "MANAGER" ->
                ((currentStatus in setOf("PLACED", "PREPARING")) && nextStatus == "CANCELLED" && paymentStatus == "PENDING") ||
                    (currentStatus == "READY" && nextStatus == "COLLECTED" && paymentStatus == "CAPTURED")
            else -> false
        }
        if (!permitted) {
            throw HubCommandRejectedException("The verified $role session cannot change $currentStatus to $nextStatus under the current payment state.")
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
        const val MAX_CASH_AMOUNT = 999_999_999.99
        const val MAX_STOCK_QUANTITY = 99_999_999_999.999
        const val MAX_ITEM_NAME_LENGTH = 500
        const val MONEY_EPSILON = 0.000_001
        const val QUANTITY_EPSILON = 0.000_001
        val SUPPORTED_TENDER_INTENTS = setOf("CASH", "CARD", "SPAZAPAY_QR")
        val CAPTURABLE_ORDER_STATUSES = setOf("PLACED", "PREPARING", "READY")
    }
}
