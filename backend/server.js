require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fetch = require('node-fetch');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();

const app = express();

// ===========================
//       MIDDLEWARE
// ===========================
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json()); // Extra safety for JSON
app.use(cors());
app.use(express.static(path.join(__dirname, '../frontend')));

// ===========================
//       DATABASE INIT
// ===========================
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('DB Open Error:', err.message);
  else {
    console.log('Connected to SQLite Database at:', dbPath);
    // Verifying table existence and user count
    db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='users';", (err, row) => {
       if (row) {
         db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
           if (!err && row) console.log(`Database initialized. Current user count: ${row.count}`);
         });
       }
    });
  }
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    email TEXT UNIQUE,
    password TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    type TEXT,
    summary TEXT,
    payload TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    type TEXT,
    amount REAL,
    category TEXT,
    description TEXT,
    date DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
});

// Graceful Shut-down to ensure DB flushes
process.on('SIGINT', () => {
  db.close((err) => {
    if (err) console.error(err.message);
    console.log('Closed the database connection.');
    process.exit(0);
  });
});

// ===========================
//       HELPERS
// ===========================
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ===========================
//       ENV VARIABLES
// ===========================
const PORT = Number(process.env.PORT || 4000);
const WEATHER_KEY = process.env.WEATHER_API_KEY || '';
const DISEASE_KEY = process.env.DISEASE_API_KEY || '';
const GROQ_KEY = process.env.GROQ_API_KEY || '';

function maskKey(key) {
  if (!key) return 'missing';
  if (key.length <= 6) return 'configured';
  return `${key.slice(0, 3)}***${key.slice(-3)}`;
}

console.log('Loaded WEATHER KEY:', maskKey(WEATHER_KEY));
console.log('Loaded DISEASE KEY:', maskKey(DISEASE_KEY));
console.log('Loaded GROQ KEY:', maskKey(GROQ_KEY));

// ===========================
//       AUTHENTICATION
// ===========================
app.post('/api/signup', (req, res) => {
  const { username, password, email } = req.body;

  if (!username || !password || !email) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  db.run(`INSERT INTO users (username, password, email) VALUES (?, ?, ?)`, [username, password, email], function(err) {
    if (err) {
      if (err.message.includes('UNIQUE constraint failed')) {
        return res.status(400).json({ error: 'Username or Email already exists' });
      }
      return res.status(500).json({ error: err.message });
    }
    res.json({ success: true, user: { id: this.lastID, username, email } });
  });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  // Support both username and email login
  db.get(`SELECT * FROM users WHERE (username = ? OR email = ?) AND password = ?`, [username, username, password], (err, row) => {
    if (err || !row) return res.status(401).json({ error: 'Invalid username/email or password' });
    res.json({ success: true, user: { id: row.id, username: row.username, email: row.email } });
  });
});

// ===========================
//        HEALTH CHECK
// ===========================
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ===========================
//        SOIL ANALYSIS
// ===========================
// Step 1: validate inputs via AI
async function validateSoilInputs(payload) {
  const { crop, soil_type, nitrogen, phosphorus, potassium, sulfur, organic_matter, ph } = payload;

  // Hard numeric guards first
  const ph_num = parseFloat(ph);
  const n_num  = parseFloat(nitrogen);
  const p_num  = parseFloat(phosphorus);
  const k_num  = parseFloat(potassium);
  const s_num  = parseFloat(sulfur);
  const om_num = parseFloat(organic_matter);

  if (ph_num < 0 || ph_num > 14)
    return { valid: false, reason: `pH value of ${ph} is impossible — pH must be between 0 and 14.` };
  if (n_num < 0 || n_num > 5000)
    return { valid: false, reason: `Nitrogen value of ${nitrogen} mg/kg is unrealistic. Normal soil nitrogen is 0–5000 mg/kg.` };
  if (p_num < 0 || p_num > 3000)
    return { valid: false, reason: `Phosphorus value of ${phosphorus} mg/kg is out of realistic range (0–3000 mg/kg).` };
  if (k_num < 0 || k_num > 5000)
    return { valid: false, reason: `Potassium value of ${potassium} mg/kg is unrealistic. Normal range is 0–5000 mg/kg.` };
  if (s_num < 0 || s_num > 1000)
    return { valid: false, reason: `Sulfur value of ${sulfur} mg/kg is unrealistic. Normal range is 0–1000 mg/kg.` };
  if (om_num < 0 || om_num > 100)
    return { valid: false, reason: `Organic matter of ${organic_matter}% is impossible — must be between 0 and 100%.` };

  // AI validation for crop/soil names
  const validationPrompt = `
You are an agronomist validator. Determine if the following inputs are real and valid for a soil analysis.

Inputs:
- Crop: "${crop}"
- Soil Type: "${soil_type}"

Rules:
1. The crop must be a real agricultural crop (rice, wheat, tomato, maize, etc.). Nonsense words like "abc", "xyz", random strings, or non-crops must be flagged as invalid.
2. The soil type must be a real soil category (clay, sandy, loamy, black, red, laterite, silt, etc.). Nonsense or random words are invalid.
3. Be strict. Do not give benefit of the doubt for obviously fake inputs.

Return ONLY valid JSON:
{
  "valid": true|false,
  "reason": "If invalid, explain exactly what is wrong in one short sentence. If valid, leave as empty string."
}
`;

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: validationPrompt }],
      model: 'llama-3.3-70b-versatile',
      response_format: { type: 'json_object' },
      temperature: 0.1
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error('Validation service unavailable');
  return JSON.parse(data.choices[0].message.content);
}

// Step 2: full analysis (only runs if valid)
async function analyzeSoil(payload, weather = null) {
  if (!GROQ_KEY) throw new Error('AI Analysis (Groq) not configured in .env');

  const { crop, soil_type, nitrogen, phosphorus, potassium, sulfur, organic_matter, ph } = payload;
  const weatherDesc = weather
    ? `${weather.list?.[0]?.weather?.[0]?.description}, temp ${weather.list?.[0]?.main?.temp}°C, humidity ${weather.list?.[0]?.main?.humidity}%`
    : 'unknown';

  const prompt = `
You are a world-class agronomist AI. Provide a precise, data-driven soil analysis SPECIFICALLY for the crop and soil type provided.

FARMER INPUT DATA:
- Target Crop: "${crop}"
- Soil Type / Category: "${soil_type}"
- Measured Nitrogen (N): ${nitrogen} mg/kg
- Measured Phosphorus (P): ${phosphorus} mg/kg
- Measured Potassium (K): ${potassium} mg/kg
- Measured Sulfur (S): ${sulfur} mg/kg
- Measured Organic Matter: ${organic_matter}%
- Measured pH: ${ph}
- Local Weather Context: ${weatherDesc}

CRITICAL INSTRUCTIONS:
1. Determine optimal ranges SPECIFICALLY for "${crop}" grown in "${soil_type}" soil — not generic values.
2. Compare farmer values against those crop-specific ranges to set status: LOW, OPTIMAL, or HIGH.
3. optimal_range_min and optimal_range_max must be numbers (not strings) representing the ideal range for this crop+soil.
4. Each suggestion must be concrete and actionable for "${crop}" in "${soil_type}" soil.
5. crop_note briefly explains why this optimal range applies to this crop+soil combination.
6. Factor in local weather where relevant.

Return ONLY valid JSON:
{
  "analysis": {
    "nitrogen":      { "status": "LOW|OPTIMAL|HIGH", "value": ${nitrogen}, "optimal_range_min": 0, "optimal_range_max": 0, "optimal_range": "X-Y mg/kg", "unit": "mg/kg", "crop_note": "", "suggestion": "" },
    "phosphorus":    { "status": "LOW|OPTIMAL|HIGH", "value": ${phosphorus}, "optimal_range_min": 0, "optimal_range_max": 0, "optimal_range": "X-Y mg/kg", "unit": "mg/kg", "crop_note": "", "suggestion": "" },
    "potassium":     { "status": "LOW|OPTIMAL|HIGH", "value": ${potassium}, "optimal_range_min": 0, "optimal_range_max": 0, "optimal_range": "X-Y mg/kg", "unit": "mg/kg", "crop_note": "", "suggestion": "" },
    "sulfur":        { "status": "LOW|OPTIMAL|HIGH", "value": ${sulfur}, "optimal_range_min": 0, "optimal_range_max": 0, "optimal_range": "X-Y mg/kg", "unit": "mg/kg", "crop_note": "", "suggestion": "" },
    "organic_matter":{ "status": "LOW|OPTIMAL|HIGH", "value": ${organic_matter}, "optimal_range_min": 0, "optimal_range_max": 0, "optimal_range": "X-Y%", "unit": "%", "crop_note": "", "suggestion": "" },
    "ph":            { "status": "LOW|OPTIMAL|HIGH", "value": ${ph}, "optimal_range_min": 0, "optimal_range_max": 0, "optimal_range": "X-Y", "unit": "", "crop_note": "", "suggestion": "" }
  },
  "products": [
    {
      "name": "Product Name",
      "category": "Organic|Chemical",
      "description": "Why it helps",
      "buy_url": "Search URL"
    }
  ]
}
`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        model: 'llama-3.3-70b-versatile',
        response_format: { type: 'json_object' },
        temperature: 0.2
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Groq API call failed');

    const content = JSON.parse(data.choices[0].message.content);
    return { crop, soil_type, analysis: content.analysis, products: content.products, weather_context: weatherDesc, ai_powered: true };
  } catch (error) {
    console.error('Groq Analysis Error:', error);
    throw new Error('Failed to generate AI analysis. Please try again later.');
  }
}

app.post('/api/soil', async (req, res) => {
  try {
    if (!req.body.crop || !req.body.crop.trim())
      return res.status(400).json({ error: 'Please enter a Primary Crop name.' });
    if (!req.body.soil_type || !req.body.soil_type.trim())
      return res.status(400).json({ error: 'Please enter a Soil Category.' });

    // Validate inputs using AI
    const validation = await validateSoilInputs(req.body);
    if (!validation.valid) {
      return res.status(422).json({ error: `Invalid input: ${validation.reason}` });
    }

    const { location } = req.body;
    let weatherData = null;
    if (location && location.lat && location.lon && WEATHER_KEY) {
      try {
        const wUrl = `https://api.openweathermap.org/data/2.5/forecast?lat=${location.lat}&lon=${location.lon}&units=metric&appid=${WEATHER_KEY}`;
        const wRes = await fetch(wUrl);
        if (wRes.ok) weatherData = await wRes.json();
      } catch (locErr) {
        console.error('Contextual weather fetch failed:', locErr.message);
      }
    }

    const result = await analyzeSoil(req.body, weatherData);

    if (req.body.user_id) {
      db.run(`INSERT INTO history (user_id, type, summary, payload) VALUES (?, ?, ?, ?)`,
        [req.body.user_id, 'Soil', `Analysis for ${req.body.crop || 'Soil Sample'}`, JSON.stringify(result)]);
    }

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ===========================
//        WEATHER API
// ===========================
app.get('/api/weather', async (req, res) => {
  try {
    if (!WEATHER_KEY) {
      return res.status(500).json({ error: 'Weather API key not configured' });
    }

    const { q, lat, lon } = req.query;

    let url = '';
    if (q) {
      url = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(q)}&units=metric&appid=${WEATHER_KEY}`;
    } else if (lat !== undefined && lon !== undefined && lat !== '' && lon !== '') {
      url = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&units=metric&appid=${WEATHER_KEY}`;
    } else {
      return res.status(400).json({ error: 'City or coordinates (lat/lon) required' });
    }

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.message || 'Weather API request failed'
      });
    }

    const { user_id } = req.query;
    if (user_id) {
      const loc = data.city ? data.city.name : 'Target Location';
      db.run(`INSERT INTO history (user_id, type, summary, payload) VALUES (?, ?, ?, ?)`, 
        [user_id, 'Weather', `Forecast for ${loc}`, JSON.stringify(data)]);
    }

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===========================
//   WATER REQUIREMENT
// ===========================
app.post('/api/water', async (req, res) => {
  try {
    if (!GROQ_KEY) return res.status(500).json({ error: 'AI not configured' });
    const { crop, soil_type, planting_date, last_watering, location, weather_context, farm_area } = req.body;
    if (!crop || !soil_type) return res.status(400).json({ error: 'Crop and soil type are required.' });

    // Compute days
    const now = Date.now();
    const daysSincePlanting = planting_date
      ? Math.floor((now - new Date(planting_date)) / 86400000) : null;
    const daysSinceWatering = last_watering
      ? Math.floor((now - new Date(last_watering)) / 86400000) : null;

    // Optionally fetch live weather if location available and no context provided
    let weatherDesc = weather_context || 'unknown';
    if ((!weatherDesc || weatherDesc === 'unknown') && location && location.lat && location.lon && WEATHER_KEY) {
      try {
        const wRes = await fetch(`https://api.openweathermap.org/data/2.5/forecast?lat=${location.lat}&lon=${location.lon}&units=metric&appid=${WEATHER_KEY}`);
        if (wRes.ok) {
          const wData = await wRes.json();
          weatherDesc = `${wData.list?.[0]?.weather?.[0]?.description}, temp ${wData.list?.[0]?.main?.temp}°C, humidity ${wData.list?.[0]?.main?.humidity}%`;
        }
      } catch {}
    }

    const prompt = `
You are a precision irrigation expert AI. Calculate the water requirement for the following crop situation.

INPUTS:
- Crop: "${crop}"
- Soil Type: "${soil_type}"
- Farm Area: "${farm_area || '1'} Acres" (Note: 1 Acre = 4,046.86 sq meters)
- Days since planting: ${daysSincePlanting !== null ? daysSincePlanting + ' days' : 'unknown'}
- Days since last watering: ${daysSinceWatering !== null ? daysSinceWatering + ' days' : 'unknown'}
- Current weather: ${weatherDesc}

INSTRUCTIONS:
1. Determine the crop growth stage.
2. Calculate how much water the crop needs right now in TOTAL LITRES (L) for the given farm area. 
3. Note: 1mm of water requirement = 1 Litre per square meter ($L/m^2$).
4. Also estimate Litres per Square Meter ($L/m^2$).
5. Recommend frequency and next watering date.
6. Set urgency: HIGH|MEDIUM|LOW.
7. Give a concise practical advice note.

Return ONLY valid JSON:
{
  "water": {
    "urgency": "HIGH|MEDIUM|LOW",
    "total_litres": "e.g. 5000L",
    "litres_per_m2": "e.g. 5L/m2",
    "next_watering_in": "...",
    "frequency": "...",
    "crop_stage": "...",
    "advice": "..."
  }
}
`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        model: 'llama-3.3-70b-versatile',
        response_format: { type: 'json_object' },
        temperature: 0.2
      })
    });

    const aiData = await response.json();
    if (!response.ok) throw new Error(aiData.error?.message || 'Water AI call failed');
    const result = JSON.parse(aiData.choices[0].message.content);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===========================
//   DISEASE DETECTION (Groq Vision)
// ===========================
const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/disease', upload.single('image'), async (req, res) => {
  try {
    if (!GROQ_KEY) return res.status(500).json({ error: 'AI (Groq) not configured in .env' });
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    const mime   = req.file.mimetype || 'image/jpeg';
    const base64 = req.file.buffer.toString('base64');
    const dataUrl = `data:${mime};base64,${base64}`;

    const cropHint = req.body.crop_hint || 'unknown';
    const normalizedCropHint = (req.body.crop_hint || '').trim();

    const prompt = `You are an expert plant pathologist AI. Carefully analyze this plant/leaf image.
${cropHint !== 'unknown' ? `CONTEXT: The user identifies this plant as "${cropHint}". Use this as a reference while diagnosing.` : ''}

STEP 1: Determine if the image shows a plant, leaf, or any vegetation.
STEP 2: If it IS a plant/leaf, identify all visible diseases or health issues.
STEP 3: Provide per-disease details AND a single consolidated treatment plan.
STEP 4: Suggest 2-3 REAL, specific commercial products (pesticides/fungicides/organic) available to buy.

Return ONLY a valid JSON object in this exact format:
{
  "is_plant": true|false,
  "plant_name": "${cropHint !== 'unknown' ? cropHint : 'common plant name if identifiable, else null'}",
  "overall_health": "Healthy|Mild Issue|Moderate Issue|Severe Issue",
  "consolidated_plan": {
    "organic": "One unified organic cure strategy",
    "chemical": "One unified chemical strategy",
    "maintenance": "General pruning/care advice",
    "products": [
      {
        "name": "Specific Product Name",
        "category": "Organic|Chemical",
        "description": "Why this product helps",
        "buy_url": "Search URL or store link"
      }
    ]
  },
  "result": {
    "disease": {
      "suggestions": [{"name": "Disease", "probability": 0.0, "description": "..."}]
    }
  },
  "summary": "Health assessment"
}

If no products needed, set products to []. Use reputable products available in global or regional agricultural markets.`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: prompt }
          ]
        }],
        response_format: { type: 'json_object' },
        temperature: 0.2
      })
    });

    const aiData = await response.json();
    if (!response.ok) {
      console.error('Groq Vision error:', aiData);
      throw new Error(aiData.error?.message || 'Groq Vision API failed');
    }

    const result = JSON.parse(aiData.choices[0].message.content);

    // Crop name label policy:
    // - If user supplied crop name, always use it.
    // - If user did NOT supply crop name, do not auto-show model inferred crop label.
    if (normalizedCropHint) {
      result.plant_name = normalizedCropHint;
    } else {
      result.plant_name = null;
    }

    if (!result.is_plant) {
      return res.json({
        success: false,
        message: 'The uploaded image does not appear to be a plant or leaf. Please upload a clear plant photo.'
      });
    }

    // Save to history
    if (req.body.user_id) {
      db.run(`INSERT INTO history (user_id, type, summary, payload) VALUES (?, ?, ?, ?)`,
        [req.body.user_id, 'Disease', `Plant Health: ${result.overall_health}`, JSON.stringify(result)]);
    }

    res.json(result);
  } catch (error) {
    console.error('Disease detection error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ===========================
//   SOIL REPORT OCR EXTRACT
// ===========================
app.post('/api/soil/extract', upload.single('image'), async (req, res) => {
  try {
    if (!GROQ_KEY) return res.status(500).json({ error: 'AI not configured' });
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    const mime = req.file.mimetype || 'image/jpeg';
    const base64 = req.file.buffer.toString('base64');
    const dataUrl = `data:${mime};base64,${base64}`;

    const prompt = `You are a professional agricultural lab assistant. Analyze this soil test report image.
It may be in any language (Hindi, English, etc.) and any units.

IDENTIFY AND EXTRACT these specific values:
1. Nitrogen (N)
2. Phosphorus (P)
3. Potassium (K)
4. Sulfur (S)
5. Organic Matter (OM)
6. pH Value

CONVERSION RULES:
- If values are in lbs/acre, convert to mg/kg (1 lb/acre ≈ 1.12 mg/kg).
- If values are in percentage (%), keep as is for Organic Matter.
- Always target mg/kg for N, P, K, S.
- Always target a 0-14 scale for pH.

Return ONLY a valid JSON object:
{
  "nitrogen": number|null,
  "phosphorus": number|null,
  "potassium": number|null,
  "sulfur": number|null,
  "organic_matter": number|null,
  "ph": number|null,
  "missing_info": ["List of attributes you couldn't find clearly"],
  "language_detected": "Language name"
}

If a value is truly missing or unreadable, set it to null.`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: prompt }
          ]
        }],
        response_format: { type: 'json_object' },
        temperature: 0.1
      })
    });

    const aiData = await response.json();
    if (!response.ok) throw new Error(aiData.error?.message || 'Report extraction failed');
    
    const result = JSON.parse(aiData.choices[0].message.content);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===========================
//          HISTORY
// ===========================
app.get('/api/history', (req, res) => {
  const { user_id } = req.query;
  db.all(`SELECT * FROM history WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`, [user_id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.delete('/api/history', (req, res) => {
  const { user_id } = req.body;
  db.run(`DELETE FROM history WHERE user_id = ?`, [user_id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ===========================
//          LEDGER
// ===========================
app.get('/api/ledger', (req, res) => {
  const { user_id } = req.query;
  db.all(`SELECT * FROM ledger WHERE user_id = ? ORDER BY date DESC, id DESC`, [user_id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/ledger', (req, res) => {
  const { user_id, type, amount, category, description, date } = req.body;
  if (!user_id) return res.status(400).json({ error: 'User ID required' });
  db.run(
    `INSERT INTO ledger (user_id, type, amount, category, description, date) VALUES (?, ?, ?, ?, ?, ?)`,
    [user_id, type, amount, category, description, date || new Date().toISOString()],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    }
  );
});

app.delete('/api/ledger/:id', (req, res) => {
  const { id } = req.params;
  const { user_id } = req.body; // sending user_id in body
  db.run(`DELETE FROM ledger WHERE id = ? AND user_id = ?`, [id, user_id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ===========================
//    MARKET INTELLIGENCE
// ===========================
const MANDI_DATA = [
  { 
    commodity: 'Wheat', state: 'Punjab', market: 'Khanna', 
    min_price: 2275, max_price: 2500, modal_price: 2400, unit: 'Quintal', trend: 'up',
    buyers: [
      { name: 'Punjab State Coop Supply (Markfed)', contact: '+91 172-2741xxx', type: 'Government' },
      { name: 'Aggarwal Wheat Traders', contact: '+91 98765-43xxx', type: 'Private' }
    ]
  },
  { 
    commodity: 'Paddy (Dhan)', state: 'Haryana', market: 'Karnal', 
    min_price: 1950, max_price: 2320, modal_price: 2183, unit: 'Quintal', trend: 'stable',
    buyers: [
      { name: 'Haryana Warehousing Corp', contact: '+91 172-2703xxx', type: 'Government' },
      { name: 'Bharat Rice Mills', contact: '+91 94160-12xxx', type: 'Private' }
    ]
  }
];

app.get('/api/mandi', (req, res) => {
  const { q } = req.query;
  if (!q) return res.json(MANDI_DATA);
  const filtered = MANDI_DATA.filter(item => 
    item.commodity.toLowerCase().includes(q.toLowerCase()) || 
    item.state.toLowerCase().includes(q.toLowerCase())
  );
  res.json(filtered);
});

app.get('/api/mandi/discover', async (req, res) => {
  try {
    const { crop } = req.query;
    if (!crop || !GROQ_KEY) return res.status(400).json({ error: 'Crop name required' });

    const prompt = `
You are a professional agricultural market analyst. Research and provide a REAL-TIME state-wise market comparison for "${crop}" in India (Current season 2024-2025).

TASK:
1. Identify the TOP 4-5 major producing states for "${crop}".
2. For each state, provide the primary Mandi/Market hub.
3. Provide the prices in the MOST STANDARD unit used for "${crop}" in the actual market (e.g., "Tonne" for sugarcane, "Quintal" for grains/cotton, "Kg" for expensive spices, etc.). Tell me exactly what unit you are using using the "unit" format.
4. For each state, provide 2 real buyer types/contacts.

Return ONLY valid JSON in this exact format:
{
  "crop": "${crop}",
  "results": [
    {
      "state": "State Name",
      "market": "Main Market Name",
      "min_price": 0,
      "max_price": 0,
      "modal_price": 0,
      "unit": "Appropriate Unit (e.g. Quintal, Tonne, Kg)",
      "trend": "up|down|stable",
      "buyers": [
        { "name": "Buyer Name", "contact": "+91 XXXXX-XXXXX", "type": "Govt|Private|Corporate" }
      ]
    }
  ]
}
`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        model: 'llama-3.3-70b-versatile',
        response_format: { type: 'json_object' },
        temperature: 0.1
      })
    });

    const aiData = await response.json();
    if (!response.ok) throw new Error(aiData.error?.message || 'AI Discovery failed');
    res.json(JSON.parse(aiData.choices[0].message.content));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/mandi/intelligence', async (req, res) => {
  try {
    if (!GROQ_KEY) return res.status(500).json({ error: 'AI not configured' });
    const { commodity, price, market, unit } = req.body;

    // Convert whatever the user entered into Quintals for flawless AI comparison
    let numPrice = parseFloat(price);
    let pricePerQuintal = numPrice;

    if (unit === 'Tonne') {
      pricePerQuintal = numPrice / 10;
    } else if (unit === 'Kg') {
      pricePerQuintal = numPrice * 100;
    }

    const prompt = `
SYSTEM: You are a strict price evaluator for Indian farmers. ALL benchmarks and evaluations must be done in QUINTALS to avoid math errors. 

INPUT:
CROP: ${commodity}
USER'S ORIGINAL OFFER: ₹${numPrice} per ${unit}
CONVERTED VALUE: ₹${pricePerQuintal} per Quintal

STANDARD MARKET BENCHMARKS (PER QUINTAL):
- Sugarcane (FRP): ₹315 - ₹340 per Quintal
- Wheat/Rice/Grains: ₹2,100 - ₹2,500 per Quintal
- Vegetables (Tomato/Onion): ₹1,500 - ₹4,000 per Quintal
- Cotton/Soybean: ₹4,000 - ₹7,000 per Quintal

RULES:
1. Compare the CONVERTED VALUE (₹${pricePerQuintal} per Quintal) against the standard benchmarks for the crop.
2. If ₹${pricePerQuintal} per Quintal is close to the benchmark, it is FAIR or GOOD. If it is way off, it is POOR.
3. In your analysis, explain it simply: "Your offer of ₹${numPrice}/${unit} equals ₹${pricePerQuintal} per Quintal. The standard rate is [X] per Quintal, making your price [Fair/Poor]."

Return ONLY JSON:
{
  "rating": "GOOD|FAIR|POOR",
  "label": "Price Status",
  "analysis": "Short explanation showing the conversion to Quintal and comparing it to the standard Quintal rate.",
  "advice": "Clear recommendation.",
  "expected_range": "Show expected range in Quintals e.g. ₹315 - ₹340 per Quintal"
}
`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        model: 'llama-3.3-70b-versatile',
        response_format: { type: 'json_object' },
        temperature: 0.0 // ZERO creativity, strictly literal results
      })
    });

    const aiData = await response.json();
    if (!response.ok) throw new Error(aiData.error?.message || 'Price Intelligence failed');
    res.json(JSON.parse(aiData.choices[0].message.content));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===========================
//      FRONTEND FALLBACK
// ===========================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ===========================
//        START SERVER
// ===========================
function startServer(port, canRetry = true) {
  const server = app.listen(port, () => {
    console.log('Farmer Assistant running on http://localhost:' + port);
  });

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && canRetry) {
      const fallbackPort = Number(port) + 1;
      console.warn(`Port ${port} is already in use. Retrying on ${fallbackPort}.`);
      startServer(fallbackPort, false);
      return;
    }

    console.error('Failed to start server:', err.message);
    process.exit(1);
  });
}

startServer(PORT);
