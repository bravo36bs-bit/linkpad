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
});
    // كود إنشاء الجدول لضمان وجوده
   // كود إنشاء الجداول لضمان وجودها جميعاً
const createTables = () => {
    const usersTable = `
    CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        email VARCHAR(255)
    );`;

    const friendsTable = `
    CREATE TABLE IF NOT EXISTS friends (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        friend_id INT,
        status ENUM('pending', 'accepted') DEFAULT 'pending',
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (friend_id) REFERENCES users(id),
        UNIQUE KEY unique_friendship (user_id, friend_id)
    );`;

    const messagesTable = `
    CREATE TABLE IF NOT EXISTS private_messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sender_id INT,
        receiver_id INT,
        content TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (sender_id) REFERENCES users(id),
        FOREIGN KEY (receiver_id) REFERENCES users(id)
);`;

    db.query(usersTable, (err) => {
        if (err) console.error("❌ Error users table:", err.message);
        db.query(friendsTable, (err) => {
            if (err) console.error("❌ Error friends table:", err.message);
            db.query(messagesTable, (err) => {
                if (err) console.error("❌ Error messages table:", err.message);
                else console.log("🚀 All tables are ready in Aiven!");
            });
        });
    });
};

// استدعاء الدالة بعد الاتصال
createTables();


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
// التسجيل المعدل مع التشفير
app.post('/register', async (req, res) => {
    console.log("--- New Register Request ---");
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: "Username or password missing" });
    }

    try {
        // 1. تشفير كلمة السر قبل الحفظ
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // 2. حفظ كلمة السر المشفرة في القاعدة
        const query = 'INSERT INTO users (username, password) VALUES (?, ?)';
        db.query(query, [username, hashedPassword], (err, result) => {
            if (err) {
                console.log("❌ DB Error:", err.message);
                return res.status(500).json({ error: err.message });
            }
            console.log("✅ User registered with hashed password!");
            res.status(200).json({ message: "Success" });
        });
    } catch (error) {
        res.status(500).json({ error: "Server error during registration" });
    }
});

// تسجيل الدخول
app.post('/login', (req, res) => {
    const username = req.body.username.trim();
const password = req.body.password.trim();
    const sql = "SELECT * FROM users WHERE username = ?";
    db.query(sql, [username], async (err, results) => {
        if (err || results.length === 0) return res.status(401).json({ error: "User not found" });
        const user = results[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ error: "Wrong password" });
        
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token });
        console.log("Input Pass:", password);
console.log("Stored Pass in DB:", user.password);
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
// جلب طلبات الصداقة الواردة (المعدل)
app.get('/get-friend-requests', authenticateToken, (req, res) => {
    const sql = `SELECT friends.id, users.username FROM friends 
                 JOIN users ON friends.user_id = users.id 
                 WHERE friends.friend_id = ? AND friends.status = 'pending'`;
    db.query(sql, [req.user.id], (err, results) => {
        if (err) {
            console.error("❌ Error fetching requests:", err.message);
            return res.status(500).json([]); // إرسال مصفوفة فارغة في حال حدوث خطأ
        }
        // إرسال النتائج، وإذا كانت فارغة نرسل مصفوفة فارغة []
        res.json(results || []); 
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