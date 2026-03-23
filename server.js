// ─── CORS (FIX FULL) ─────────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// thêm origin local
allowedOrigins.push(
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
);

const corsOptions = {
  origin: (origin, callback) => {
    console.log('🌍 Origin:', origin);

    // ✅ DEV MODE → cho phép file:// (origin = null)
    if (process.env.NODE_ENV !== 'production') {
      if (!origin || origin === 'null') {
        console.log('⚠️ DEV: allow origin null');
        return callback(null, true);
      }
    }

    // ✅ Cho phép Netlify
    if (origin && (
      origin.endsWith('.netlify.app') ||
      origin.endsWith('.netlify.com')
    )) {
      return callback(null, true);
    }

    // ✅ Whitelist
    if (origin && allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.warn(`🚫 CORS blocked: ${origin}`);
    return callback(new Error('Not allowed by CORS'));
  },

  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

// apply cors
app.use(cors(corsOptions));

// handle preflight
app.options('*', cors(corsOptions));
