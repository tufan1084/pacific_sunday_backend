const logger = require('../config/logger');

// 30-min in-process cache keyed on lowercased query — keeps us well under
// OpenWeatherMap's free-tier limit (60 calls/min, 1M/month) and shields the
// dashboard from upstream latency.
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map();

const API_KEY = process.env.OPENWEATHER_API_KEY;
const BASE = 'https://api.openweathermap.org/data/2.5/weather';

/**
 * Fetch current weather for a place. Accepts a city + optional state/country
 * (state used only for US disambiguation). Returns:
 *
 *   { location, tempF, tempC, condition, wind, playingCondition }
 *
 * playingCondition is a coarse golf-friendliness label derived locally so
 * the dashboard doesn't have to know about temperature thresholds.
 *
 * Returns null on any error (missing key, network failure, 4xx) so the
 * caller can degrade gracefully — we'd rather hide the widget than crash
 * the whole dashboard payload.
 */
async function getWeatherFor({ city, state, country }) {
  if (!city) return null;
  if (!API_KEY) {
    logger.warn('weatherService: OPENWEATHER_API_KEY not set — skipping weather lookup');
    return null;
  }

  const parts = [city, state, country].filter(Boolean);
  const queryKey = parts.join(',').toLowerCase();
  const cached = cache.get(queryKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.data;
  }

  // OpenWeatherMap accepts `q={city},{state},{country}`. State is only
  // meaningful for US — for other countries it's harmless extra context.
  const params = new URLSearchParams({
    q: parts.join(','),
    appid: API_KEY,
    units: 'imperial', // tempF; we'll derive °C
  });

  try {
    const res = await fetch(`${BASE}?${params.toString()}`);
    if (!res.ok) {
      logger.warn(`weatherService: ${res.status} for ${queryKey}`);
      cache.set(queryKey, { at: Date.now(), data: null });
      return null;
    }
    const json = await res.json();
    const tempF = Math.round(json.main?.temp);
    const tempC = Math.round((tempF - 32) * (5 / 9));
    const condition = json.weather?.[0]?.description
      ? json.weather[0].description.replace(/\b\w/g, (c) => c.toUpperCase())
      : 'Unknown';
    const windMph = json.wind?.speed != null ? Math.round(json.wind.speed) : null;
    const windDir = degreesToCardinal(json.wind?.deg);
    const wind = windMph != null ? `Wind ${windMph}mph${windDir ? ' ' + windDir : ''}` : null;

    const data = {
      location: parts.join(', '),
      tempF,
      tempC,
      condition,
      wind,
      playingCondition: classifyPlayingCondition(tempF, condition, windMph),
    };
    cache.set(queryKey, { at: Date.now(), data });
    return data;
  } catch (err) {
    logger.error(`weatherService fetch failed: ${err.message}`);
    return null;
  }
}

function degreesToCardinal(deg) {
  if (deg == null || Number.isNaN(deg)) return null;
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(((deg % 360) / 45)) % 8];
}

function classifyPlayingCondition(tempF, condition, windMph) {
  const c = (condition || '').toLowerCase();
  if (c.includes('thunder') || c.includes('storm')) return 'Poor';
  if (c.includes('rain') || c.includes('snow') || c.includes('sleet')) return 'Poor';
  if (windMph != null && windMph >= 25) return 'Poor';
  if (tempF < 40 || tempF > 95) return 'Fair';
  if (windMph != null && windMph >= 15) return 'Fair';
  return 'Good';
}

module.exports = { getWeatherFor };
