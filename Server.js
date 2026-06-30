require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET;
const USDA_API_KEY = process.env.USDA_API_KEY;
const PORT = 5050;

// ─── DATABASE ─────────────────────────────────────────────────
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: process.env.DB_PASSWORD,
    database: 'nutritionanalyser'
});
db.connect(err => {
    if (err) console.log("❌ DB Error:", err.message);
    else console.log("✅ MySQL Connected!");
});

// ─── JWT MIDDLEWARE ───────────────────────────────────────────


const auth = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        return res.status(401).json({ error: 'Invalid token' });
    }
};

// ─── TEST ─────────────────────────────────────────────────────
app.get('/', (req, res) => res.send("✅ NutriLyze Running!"));

// ─── 1. REGISTER ──────────────────────────────────────────────
app.post('/register', async (req, res) => {
    const { user_name, email, password, full_name, gender, date_of_birth, activity_level } = req.body;
    if (!user_name || !email || !password)
        return res.status(400).json({ error: 'Username, email & password required' });

    db.query('SELECT user_id FROM Users WHERE email = ?', [email], async (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        if (rows.length > 0) return res.status(409).json({ error: 'Email already registered!' });

        const hashed = await bcrypt.hash(password, 10);
        db.query(
            `INSERT INTO Users (user_name, email, password, full_name, gender, date_of_birth, activity_level) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [user_name, email, hashed, full_name, gender, date_of_birth, activity_level],
            (err, result) => {
                if (err) return res.status(500).json({ error: err.message });
                const token = jwt.sign({ user_id: result.insertId, email, user_name }, JWT_SECRET, { expiresIn: '7d' });
                res.json({ message: '✅ Registered!', user_id: result.insertId, token });
            }
        );
    });
});
// ─── 2. LOGIN ─────────────────────────────────────────────────
app.post('/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email & password required' });

    db.query('SELECT * FROM Users WHERE email = ?', [email], async (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) return res.status(401).json({ error: 'Invalid email or password' });

        const user = results[0];
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ error: 'Invalid email or password' });

        const token = jwt.sign(
            { user_id: user.user_id, email: user.email, user_name: user.user_name, role: user.role },
            JWT_SECRET, { expiresIn: '7d' }
        );
        res.json({
            message: '✅ Login successful!',
            token,
            user: {
                user_id: user.user_id,
                user_name: user.user_name,
                full_name: user.full_name,
                email: user.email,
                gender: user.gender,
                activity_level: user.activity_level,
                role: user.role
            }
        });
    });
});

// ─── 3. PROFILE ───────────────────────────────────────────────
app.get('/profile', auth, (req, res) => {
    db.query(
        'SELECT user_id, user_name, full_name, email, gender, date_of_birth, activity_level, created_at FROM Users WHERE user_id = ?',
        [req.user.user_id], (err, results) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(results[0]);
        }
    );
});

// ─── 4. SAVE GOAL ─────────────────────────────────────────────
app.post('/save-goal', auth, (req, res) => {
    const { goal_type, target_calories, target_protein, weight_kg, height_cm, bmi } = req.body;
    const user_id = req.user.user_id;
    const today = new Date().toISOString().split('T')[0];

    const goalMap = { lose: 'weight_loss', maintain: 'maintenance', gain: 'muscle_gain' };
    const mapped_goal = goalMap[goal_type] || goal_type;

    db.query('UPDATE User_Goal SET is_active = 0 WHERE user_id = ?', [user_id], (err) => {
        if (err) return res.status(500).json({ error: err.message });

        db.query(
            `INSERT INTO User_Goal (user_id, goal_type, start_date, is_active) VALUES (?, ?, ?, 1)`,
            [user_id, mapped_goal, today],
            (err, result) => {
                if (err) return res.status(500).json({ error: err.message });

                if (weight_kg && height_cm) {
                    db.query(
                        'INSERT INTO Body_Measurements (user_id, date, weight_kg, height_cm) VALUES (?, ?, ?, ?)',
                        [user_id, today, weight_kg, height_cm], () => {}
                    );
                }

                res.json({
                    message: '✅ Goal saved!',
                    goal_id: result.insertId,
                    goal_type: mapped_goal,
                    target_calories,
                    target_protein,
                    bmi
                });
            }
        );
    });
});

// ─── 5. GET GOAL ──────────────────────────────────────────────
app.get('/get-goal', auth, (req, res) => {
    db.query(
        'SELECT * FROM User_Goal WHERE user_id = ? AND is_active = 1 ORDER BY goal_id DESC LIMIT 1',
        [req.user.user_id], (err, results) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(results[0] || null);
        }
    );
});

// ─── 6. SEARCH FOOD ───────────────────────────────────────────
app.get('/search-food', async (req, res) => {
    const { query } = req.query;
    if (!query) return res.status(400).json({ error: 'Food query required' });

    // Pehle local database check karo
    db.query(
        'SELECT * FROM Food_Item WHERE food_name LIKE ? AND calories > 0 LIMIT 5',
        [`%${query}%`],
        async (err, localResults) => {
            if (err) return res.status(500).json({ error: err.message });

            if (localResults.length > 0) {
                // Local data mila — return karo
                const foods = localResults.map(f => ({
                    fdc_id: f.food_id,
                    food_name: f.food_name,
                    brand: 'Local DB',
                    data_type: 'Local',
                    calories: f.calories,
                    protein: f.protein,
                    carbs: f.carbs,
                    fat: f.fat,
                    fiber: f.fiber,
                    sugar: 0,
                    sodium: 0,
                    serving_size: '100g'
                }));
                return res.json(foods);
            }

            // Local mein nahi mila — USDA API call karo
            try {
                const url = `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(query)}&pageSize=20&api_key=${USDA_API_KEY}`;
                const response = await fetch(url);
                const data = await response.json();

                if (!data.foods || data.foods.length === 0) return res.json([]);

                const getNutrient = (nutrients, ...names) => {
                    for (const name of names) {
                        const found = nutrients.find(n => n.nutrientName.toLowerCase().includes(name.toLowerCase()));
                        if (found && found.value > 0) return Math.round(found.value * 10) / 10;
                    }
                    return 0;
                };

                const foods = data.foods
                    .map(food => ({
                        fdc_id: food.fdcId,
                        food_name: food.description,
                        brand: food.brandOwner || food.brandName || 'Generic',
                        data_type: food.dataType,
                        calories: getNutrient(food.foodNutrients, 'energy', 'calories'),
                        protein: getNutrient(food.foodNutrients, 'protein'),
                        carbs: getNutrient(food.foodNutrients, 'carbohydrate'),
                        fat: getNutrient(food.foodNutrients, 'total lipid', 'fat'),
                        fiber: getNutrient(food.foodNutrients, 'fiber'),
                        sugar: getNutrient(food.foodNutrients, 'sugars'),
                        sodium: getNutrient(food.foodNutrients, 'sodium'),
                        serving_size: food.servingSize ? `${food.servingSize}${food.servingSizeUnit || 'g'}` : '100g'
                    }))
                    .filter(f => f.calories > 0)
                    .slice(0, 8);

                res.json(foods);
            } catch (err) {
                res.status(500).json({ error: 'USDA API Error: ' + err.message });
            }
        }
    );
});

// ─── 7. LOG FOOD ──────────────────────────────────────────────
app.post('/log-food', auth, (req, res) => {
    const { food_name, calories, protein, carbs, fat, fiber, meal_type } = req.body;
    const user_id = req.user.user_id;
    const today = new Date().toISOString().split('T')[0];
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    db.query('SELECT log_id FROM Daily_Logs WHERE user_id = ? AND log_date = ?', [user_id, today], (err, logs) => {
        if (err) return res.status(500).json({ error: err.message });

        const saveFood = (log_id) => {
            db.query('SELECT food_id FROM Food_Item WHERE food_name = ?', [food_name], (err, existing) => {
                if (err) return res.status(500).json({ error: err.message });

                const insertMeal = () => {
                    db.query(
                        'INSERT INTO Meal (log_id, meal_name, meal_time) VALUES (?, ?, ?)',
                        [log_id, `${meal_type || 'Meal'}: ${food_name}`, now],
                        (err, mealRes) => {
                            if (err) return res.status(500).json({ error: err.message });
                            res.json({ message: '✅ Food logged!', log_id, meal_id: mealRes.insertId });
                        }
                    );
                };

                if (existing.length > 0) {
                    insertMeal();
                } else {
                    db.query(
                        'INSERT INTO Food_Item (food_name, calories, protein, carbs, fat, fiber) VALUES (?, ?, ?, ?, ?, ?)',
                        [food_name, calories, protein, carbs, fat, fiber],
                        (err) => {
                            if (err) return res.status(500).json({ error: err.message });
                            insertMeal();
                        }
                    );
                }
            });
        };

        if (logs.length > 0) {
            saveFood(logs[0].log_id);
        } else {
            db.query('INSERT INTO Daily_Logs (user_id, log_date) VALUES (?, ?)', [user_id, today], (err, r) => {
                if (err) return res.status(500).json({ error: err.message });
                saveFood(r.insertId);
            });
        }
    });
});
// ─── 8. TODAY'S LOG ───────────────────────────────────────────
app.get('/daily-log', auth, (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const sql = `
        SELECT m.meal_id, m.meal_name, m.meal_time, dl.log_date,
               fi.calories, fi.protein, fi.carbs, fi.fat, fi.fiber
        FROM Daily_Logs dl
        JOIN Meal m ON m.log_id = dl.log_id
        LEFT JOIN Food_Item fi ON fi.food_name = SUBSTRING(m.meal_name, LOCATE(': ', m.meal_name) + 2)
        WHERE dl.user_id = ? AND dl.log_date = ?
        ORDER BY m.meal_time ASC
    `;
    db.query(sql, [req.user.user_id, today], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// ─── 9. LOG WATER ─────────────────────────────────────────────
app.post('/log-water', auth, (req, res) => {
    const { amount_ml } = req.body;
    const user_id = req.user.user_id;
    const today = new Date().toISOString().split('T')[0];

    db.query('SELECT log_id FROM Daily_Logs WHERE user_id = ? AND log_date = ?', [user_id, today], (err, logs) => {
        if (err) return res.status(500).json({ error: err.message });

        const saveWater = (log_id) => {
            db.query('INSERT INTO Water_Log (log_id, amount_ml, logged_at) VALUES (?, ?, NOW())', [log_id, amount_ml], err => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ message: '✅ Water logged!' });
            });
        };

        if (logs.length > 0) {
            saveWater(logs[0].log_id);
        } else {
            db.query('INSERT INTO Daily_Logs (user_id, log_date) VALUES (?, ?)', [user_id, today], (err, r) => {
                if (err) return res.status(500).json({ error: err.message });
                saveWater(r.insertId);
            });
        }
    });
});

// ─── 10. GET WATER LOG ────────────────────────────────────────
app.get('/water-log', auth, (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const sql = `SELECT total_water_ml as total_ml FROM water_intake_summary WHERE user_id = ? AND log_date = ?`;
    db.query(sql, [req.user.user_id, today], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ total_ml: results[0]?.total_ml || 0 });
    });
});

// ─── 11. BODY MEASUREMENTS ────────────────────────────────────
app.get('/measurements', auth, (req, res) => {
    db.query(
        'SELECT * FROM Body_Measurements WHERE user_id = ? ORDER BY date DESC LIMIT 10',
        [req.user.user_id], (err, results) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(results);
        }
    );
});

app.post('/measurements', auth, (req, res) => {
    const { weight_kg, height_cm, body_fat_percent } = req.body;
    const today = new Date().toISOString().split('T')[0];
    db.query(
        'INSERT INTO Body_Measurements (user_id, date, weight_kg, height_cm, body_fat_percent) VALUES (?, ?, ?, ?, ?)',
        [req.user.user_id, today, weight_kg, height_cm, body_fat_percent],
        (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            const bmi = height_cm ? (weight_kg / ((height_cm / 100) ** 2)).toFixed(1) : null;
            res.json({ message: '✅ Measurement saved!', id: result.insertId, bmi });
        }
    );
});

// ─── ADMIN MIDDLEWARE ─────────────────────────────────────────
const adminAuth = (req, res, next) => {
    if (req.user.role !== 'admin')
        return res.status(403).json({ error: 'Admin access required!' });
    next();
};

// ─── 12. ALL USERS (Admin only) ───────────────────────────────
app.get('/users', auth, adminAuth, (req, res) => {
    db.query('SELECT user_id, user_name, email, full_name, gender, role, created_at FROM Users', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// ─── DELETE MEAL ──────────────────────────────────────────────
app.delete('/delete-meal/:meal_id', auth, (req, res) => {
    const { meal_id } = req.params;
    db.query('DELETE FROM Meal WHERE meal_id = ?', [meal_id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: '✅ Meal deleted!' });
    });
});
async function deleteMeal(meal_id) {
    if (!confirm('Delete this meal?')) return;
    try {
        const res = await apiFetch(`/delete-meal/${meal_id}`, 'DELETE');
        const data = await res.json();
        if (res.ok) {
            showToast('Meal deleted! 🗑️');
            loadTodayLog();
            loadDashboard();
        }
    } catch(e) {
        showToast('Error deleting meal', 'error');
    }
}
// ─── START ────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`🚀 NutriLyze running at http://localhost:${PORT}`));