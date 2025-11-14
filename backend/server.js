require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fetch = require('node-fetch');
const multer = require('multer');

const app = express();

// middleware
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../frontend')));

// env values
const PORT = process.env.PORT || 4000;
const WEATHER_KEY = process.env.WEATHER_API_KEY || '';
const DISEASE_KEY = process.env.DISEASE_API_KEY || '';

console.log("Loaded WEATHER KEY:", WEATHER_KEY);
console.log("Loaded DISEASE KEY:", DISEASE_KEY);

// HEALTH CHECK
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// SOIL ANALYSIS
function analyzeSoil(payload) {
  const ideal = {
    nitrogen: [80, 120],
    phosphorus: [20, 40],
    potassium: [100, 150],
    sulfur: [10, 20],
    organic_matter: [1.5, 3.0],
    ph: [6.0, 7.5]
  };

  const suggestions = {
    nitrogen: {
      low: 'Add compost or urea fertilizer.',
      high: 'Avoid nitrogen fertilizers for 2–3 weeks.',
      optimal: 'Nitrogen level is perfect.'
    },
    phosphorus: {
      low: 'Add phosphate fertilizer.',
      high: 'Avoid phosphorus fertilizers.',
      optimal: 'Phosphorus level is perfect.'
    },
    potassium: {
      low: 'Add potash or banana compost.',
      high: 'Avoid potash fertilizers.',
      optimal: 'Potassium level is perfect.'
    },
    sulfur: {
      low: 'Add gypsum or sulfur fertilizer.',
      high: 'Reduce sulfur-based fertilizers.',
      optimal: 'Sulfur level is perfect.'
    },
    organic_matter: {
      low: 'Add cow dung, compost, or vermicompost.',
      high: 'Organic matter is excellent.',
      optimal: 'Organic matter level is good.'
    },
    ph: {
      low: 'Add lime to reduce acidity.',
      high: 'Add sulfur to reduce alkalinity.',
      optimal: 'pH is optimal.'
    }
  };

  const out = { crop: payload.crop, soil_type: payload.soil_type, analysis: {} };

  function checkRange(key, value) {
    const [low, high] = ideal[key];
    if (value < low) return { status: "LOW", value, suggestion: suggestions[key].low };
    if (value > high) return { status: "HIGH", value, suggestion: suggestions[key].high };
    return { status: "OPTIMAL", value, suggestion: suggestions[key].optimal };
  }

  out.analysis.nitrogen = checkRange("nitrogen", Number(payload.nitrogen));
  out.analysis.phosphorus = checkRange("phosphorus", Number(payload.phosphorus));
  out.analysis.potassium = checkRange("potassium", Number(payload.potassium));
  out.analysis.sulfur = checkRange("sulfur", Number(payload.sulfur));
  out.analysis.organic_matter = checkRange("organic_matter", Number(payload.organic_matter));
  out.analysis.ph = checkRange("ph", Number(payload.ph));

  return out;
}

app.post('/api/soil', (req, res) => {
  try {
    res.json(analyzeSoil(req.body));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// WEATHER API
app.get('/api/weather', async (req, res) => {
  try {
    if (!WEATHER_KEY) {
      return res.status(500).json({ error: "Weather API key not configured" });
    }

    const { q, lat, lon } = req.query;
    let url = "";

    if (q) {
      url = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(q)}&units=metric&appid=${WEATHER_KEY}`;
    } else if (lat && lon) {
      url = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&units=metric&appid=${WEATHER_KEY}`;
    } else {
      return res.status(400).json({ error: "City or coordinates are required" });
    }

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// =====================================================
// ✅ FIXED: DISEASE DETECTION FOR PLANT.ID v3
// =====================================================
// FIXED DISEASE DETECTION (Plant.id v3)
const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/disease', upload.single("image"), async (req, res) => {
  try {
    if (!DISEASE_KEY) {
      return res.status(500).json({ error: "Disease API key not configured" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    const base64Image = req.file.buffer.toString("base64");

    const apiResponse = await fetch("https://plant.id/api/v3/health_assessment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Api-Key": DISEASE_KEY
      },
      body: JSON.stringify({
        images: [base64Image],
        classification_level: "species",
        similar_images: true,
        health: "only"
      })
    });

    const text = await apiResponse.text();

    try {
      res.json(JSON.parse(text));
    } catch {
      res.status(500).json({
        error: "Plant.id returned a non-JSON response",
        message: text
      });
    }

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// FRONTEND
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

// START SERVER
app.listen(PORT, () => {
  console.log("Farmer Assistant running on http://localhost:" + PORT);
});
