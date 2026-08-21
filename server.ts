import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { createClient } from '@supabase/supabase-js';

const PORT = 3000;
const HOST = '0.0.0.0';

// Initialize Supabase if env vars available
const supabaseUrl = process.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || '';
const supabase = (supabaseUrl && supabaseAnonKey) ? createClient(supabaseUrl, supabaseAnonKey) : null;

// File-backed memory store for shared cross-device state
const STORE_PATH = '/tmp/plugos_cloud_store.json';

interface CloudStore {
  pairing_codes: Record<string, any>;
  devices: Record<string, any>;
  business_configs: Record<string, any>;
}

function loadCloudStore(): CloudStore {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const data = fs.readFileSync(STORE_PATH, 'utf-8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('[SERVER STORE] Failed loading store, initializing fresh:', e);
  }
  return { pairing_codes: {}, devices: {}, business_configs: {} };
}

function saveCloudStore(store: CloudStore) {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf-8');
  } catch (e) {
    console.error('[SERVER STORE] Failed saving store:', e);
  }
}

const cloudStore = loadCloudStore();

// Helper to sanitize business config before returning to unauthenticated paired devices
function sanitizeBusinessConfig(config: any) {
  if (!config) return null;
  const sanitized = JSON.parse(JSON.stringify(config));

  if (Array.isArray(sanitized.staff)) {
    sanitized.staff = sanitized.staff.map((s: any) => {
      // Keep PIN for employee terminal login, strip passwords/tokens
      const { password, passwordHash, authSecret, ...safeStaff } = s;
      return safeStaff;
    });
  }

  if (sanitized.business) {
    const { password, passwordHash, ownerCredentials, bankAccount, ...safeBiz } = sanitized.business;
    sanitized.business = safeBiz;
  }

  delete sanitized.financialAnalytics;
  delete sanitized.financialReports;
  delete sanitized.ownerPasscodes;

  return sanitized;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // CORS headers for all origins
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  // =========================================
  // API ROUTES (Must be defined BEFORE Vite)
  // =========================================

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Deprecated Legacy Pairing Endpoints (Superceded by R002 Database RPCs)
  app.all(['/api/pairing/generate', '/api/pairing/validate', '/api/pairing/register-device', '/api/pairing/cancel', '/api/pairing/active-code', '/api/pairing/business-config/save', '/api/pairing/business-config/:businessId'], (req, res) => {
    return res.status(410).json({
      error: 'Deprecation Notice: Legacy HTTP pairing endpoints have been retired under R002. Use R002 RPC primitives (create_device_pairing_code, pair_device_with_code, get_device_bootstrap) via Supabase RPC.'
    });
  });

  // 7. Devices List & Single Device Resolution for Business
  app.get('/api/devices', (req, res) => {
    const businessId = req.query.businessId as string;
    const list = Object.values(cloudStore.devices).filter(
      (d: any) => !businessId || d.business_id === businessId
    );
    return res.json({ devices: list });
  });

  app.get('/api/devices/:deviceId', (req, res) => {
    const deviceId = req.params.deviceId;
    const device = cloudStore.devices[deviceId];
    if (!device) {
      return res.status(404).json({ error: 'Device record not found' });
    }
    return res.json({ device });
  });

  app.post('/api/devices/save', (req, res) => {
    const device = req.body;
    if (device && device.device_id) {
      cloudStore.devices[device.device_id] = device;
      saveCloudStore(cloudStore);
      if (supabase) {
        (async () => {
          try {
            await supabase.from('devices').upsert([device]);
            await supabase.from('device_records').upsert([device]);
          } catch (e) {}
        })();
      }
    }
    return res.json({ success: true, device });
  });

  // =========================================
  // VITE / STATIC SERVING
  // =========================================

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, HOST, () => {
    console.log(`ThePlugOS Server running on http://${HOST}:${PORT}`);
  });
}

startServer();
