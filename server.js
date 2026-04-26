require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const path = require('path');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const app = express();
const JWT_SECRET = 'LinkPad_2026_Secure';
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static('public'));

// --- الاتصال بقاعدة البيانات ---

// تأكد أنك تستخدم mysql2 في أعلى الملف: const mysql = require('mysql2');

const connectionUri = process.env.DATABASE_URL;



// إعداد الاتصال باستخدام المتغيرات المنفصلة
const db = mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || 'your_local_password', // كلمة سر جهازك للعمل المحلي
    database: process.env.DB_NAME || 'linkpad_db',          // اسم قاعدتك المحلية
    port: process.env.DB_PORT || 3306,
    ssl: {
        rejectUnauthorized: false // هذا السطر هو مفتاح الأمان لـ Aiven
    }
});

db.connect((err) => {
    if (err) {
        console.error("❌ Database Connection Failed: " + err.message);
        return;
    }
    console.log("✅ Connected to Aiven MySQL Successfully (Separated)! ");
    
    // كود إنشاء الجدول لضمان وجوده
    const createTableQuery = `
    CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255) NOT NULL,
        password VARCHAR(255) NOT NULL
    );`;
    
    db.query(createTableQuery, (err) => {
        if (err) console.error("❌ Error creating table:", err.message);
        else console.log("🚀 Tables are ready in Aiven!");
    });
});


// --- Middleware للتحقق من التوكن (لسهولة الكود) ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Access Denied" });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: "Invalid Token" });
        req.user = user;
        next();
    });
};

// --- المسارات الأساسية ---

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html')); 
});

// التسجيل
app.post('/register', (req, res) => {
    // هذا السطر سيطبع لك في الـ Logs أي بيانات تصل للسيرفر
    console.log("--- New Register Request ---");
    console.log("Body received:", req.body); 

    const { username, password } = req.body;

    if (!username || !password) {
        console.log("❌ Missing fields!");
        return res.status(400).json({ error: "Username or password missing" });
    }

    const query = 'INSERT INTO users (username, password) VALUES (?, ?)';
    db.query(query, [username, password], (err, result) => {
        if (err) {
            console.log("❌ DB Error:", err.message);
            return res.status(500).json({ error: err.message });
        }
        console.log("✅ User registered successfully!");
        res.status(200).json({ message: "Success" });
    });
});

// تسجيل الدخول
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const sql = "SELECT * FROM users WHERE username = ?";
    db.query(sql, [username], async (err, results) => {
        if (err || results.length === 0) return res.status(401).json({ error: "User not found" });
        const user = results[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ error: "Wrong password" });
        
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token });
    });
});

// --- نظام البحث (اسم مستخدم أو إيميل) ---
app.get('/search-user', authenticateToken, (req, res) => {
    const query = req.query.query;
    const sql = "SELECT id, username, email FROM users WHERE (email = ? OR username = ?) AND id != ?";
    db.query(sql, [query, query, req.user.id], (err, results) => {
        if (err) return res.status(500).send("Database error");
        if (results.length > 0) res.json(results[0]);
        else res.status(404).send("Not found");
    });
});

// --- نظام الأصدقاء ---

// إرسال طلب صداقة
app.post('/send-friend-request', authenticateToken, (req, res) => {
    const { friend_id } = req.body;
    const sql = "INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, 'pending')";
    db.query(sql, [req.user.id, friend_id], (err) => {
        if (err) return res.status(400).json({ error: "الطلب موجود مسبقاً" });
        res.json({ success: true });
    });
});

// جلب طلبات الصداقة الواردة
app.get('/get-friend-requests', authenticateToken, (req, res) => {
    const sql = `SELECT friends.id, users.username FROM friends 
                 JOIN users ON friends.user_id = users.id 
                 WHERE friends.friend_id = ? AND friends.status = 'pending'`;
    db.query(sql, [req.user.id], (err, results) => {
        if (err) return res.status(500).send(err);
        res.json(results);
    });
});

// قبول طلب الصداقة
app.post('/accept-friend', authenticateToken, (req, res) => {
    const { request_id } = req.body;
    const sql = "UPDATE friends SET status = 'accepted' WHERE id = ? AND friend_id = ?";
    db.query(sql, [request_id, req.user.id], (err) => {
        if (err) return res.status(500).send(err);
        res.json({ success: true });
    });
});

// جلب قائمة الأصدقاء (المقبولين فقط)
app.get('/get-friends', authenticateToken, (req, res) => {
    const sql = `
        SELECT users.id, users.username FROM friends 
        JOIN users ON (friends.user_id = users.id OR friends.friend_id = users.id)
        WHERE (friends.user_id = ? OR friends.friend_id = ?) 
        AND users.id != ? AND friends.status = 'accepted'`;
    db.query(sql, [req.user.id, req.user.id, req.user.id], (err, rows) => {
        if (err) return res.status(500).json(err);
        res.json(rows);
    });
});

// --- نظام المراسلة الخاصة (الواتساب) ---

// إرسال رسالة خاصة
app.post('/send-private-message', authenticateToken, (req, res) => {
    const { receiver_id, message } = req.body;
    // سنستخدم جدول private_messages الجديد
    const sql = "INSERT INTO private_messages (sender_id, receiver_id, content) VALUES (?, ?, ?)";
    db.query(sql, [req.user.id, receiver_id, message], (err) => {
        if (err) return res.status(500).send(err);
        res.json({ success: true });
    });
});

// جلب المحادثة بينك وبين صديق محدد
app.get('/get-messages/:friendId', authenticateToken, (req, res) => {
    const friendId = req.params.friendId;
    const userId = req.user.id;
    const sql = `
        SELECT * FROM private_messages 
        WHERE (sender_id = ? AND receiver_id = ?) 
        OR (sender_id = ? AND receiver_id = ?)
        ORDER BY created_at ASC`;
    db.query(sql, [userId, friendId, friendId, userId], (err, results) => {
        if (err) return res.status(500).send(err);
        res.json(results);
    });
});

app.listen(PORT, () => {
    console.log(`Server active on port: ${PORT}`);
});