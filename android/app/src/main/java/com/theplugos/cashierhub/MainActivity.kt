package com.theplugos.cashierhub

import android.os.Bundle
import com.getcapacitor.BridgeActivity
import com.theplugos.cashierhub.native.ThePlugOSLocalHubPlugin

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(ThePlugOSLocalHubPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
