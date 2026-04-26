require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const path = require('path');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const app = express();
const JWT_SECRET = 'LinkPad_2026_Secure';
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static('public'));

// --- الاتصال بقاعدة البيانات ---
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    ssl: { rejectUnauthorized: false }
});

db.connect((err) => {
    if (err) {
        console.error("❌ Database Connection Failed: " + err.message);
        return;
    }
    console.log("✅ Connected to Aiven MySQL!");
    createTables();
});

const createTables = () => {
    const usersTable = `CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL
    );`;

    const friendsTable = `CREATE TABLE IF NOT EXISTS friends (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        friend_id INT,
        status ENUM('pending', 'accepted') DEFAULT 'pending',
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (friend_id) REFERENCES users(id)
    );`;

    const messagesTable = `CREATE TABLE IF NOT EXISTS private_messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sender_id INT,
        receiver_id INT,
        content TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (sender_id) REFERENCES users(id),
        FOREIGN KEY (receiver_id) REFERENCES users(id)
    );`;

    db.query(usersTable, () => {
        db.query(friendsTable, () => {
            db.query(messagesTable, () => {
                console.log("🚀 All tables are ready (No Email column).");
            });
        });
    });
};

// --- Middleware ---
const authenticateToken = (req, user_res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return req.res.status(401).json({ error: "Access Denied" });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return req.res.status(403).json({ error: "Invalid Token" });
        req.user = user;
        next();
    });
};

// --- المسارات ---

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.query('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword], (err) => {
            if (err) return res.status(400).json({ error: "Username already exists" });
            res.status(200).json({ message: "Success" });
        });
    } catch { res.status(500).send("Error"); }
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE username = ?', [username], async (err, results) => {
        if (err || results.length === 0) return res.status(401).json({ error: "User not found" });
        const isMatch = await bcrypt.compare(password, results[0].password);
        if (!isMatch) return res.status(401).json({ error: "Wrong password" });
        const token = jwt.sign({ id: results[0].id, username: results[0].username }, JWT_SECRET);
        res.json({ token });
    });
});

app.get('/search-user', authenticateToken, (req, res) => {
    const query = req.query.query;
    db.query("SELECT id, username FROM users WHERE username = ? AND id != ?", [query, req.user.id], (err, results) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        if (results.length > 0) res.json(results[0]);
        else res.status(404).json({ error: "Not found" });
    });
});

app.get('/get-friend-requests', authenticateToken, (req, res) => {
    const sql = `SELECT friends.id, users.username FROM friends 
                 JOIN users ON friends.user_id = users.id 
                 WHERE friends.friend_id = ? AND friends.status = 'pending'`;
    db.query(sql, [req.user.id], (err, results) => {
        res.json(results || []);
    });
});

app.get('/get-friends', authenticateToken, (req, res) => {
    const sql = `SELECT users.id, users.username FROM friends 
                 JOIN users ON (friends.user_id = users.id OR friends.friend_id = users.id)
                 WHERE (friends.user_id = ? OR friends.friend_id = ?) 
                 AND users.id != ? AND friends.status = 'accepted'`;
    db.query(sql, [req.user.id, req.user.id, req.user.id], (err, rows) => {
        res.json(rows || []);
    });
});
// مسار إرسال طلب صداقة
app.post('/send-friend-request', authenticateToken, (req, res) => {
    const { friend_id } = req.body;
    const user_id = req.user.id;

    // التأكد من أن المستخدم لا يضيف نفسه
    if (user_id == friend_id) return res.status(400).json({ error: "لا يمكنك إضافة نفسك" });

    const sql = "INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, 'pending')";
    db.query(sql, [user_id, friend_id], (err, result) => {
        if (err) {
            // إذا كان الطلب موجوداً مسبقاً (Unique Key)
            if (err.code === 'ER_DUP_ENTRY') {
                return res.status(400).json({ error: "الطلب موجود بالفعل" });
            }
            console.error(err);
            return res.status(500).json({ error: "خطأ في السيرفر" });
        }
        res.status(200).json({ message: "تم إرسال الطلب بنجاح" });
    });
});

// مسار قبول طلب الصداقة (نحتاجه لكي يعمل زر القبول)
app.post('/accept-friend', authenticateToken, (req, res) => {
    const { request_id } = req.body;
    const sql = "UPDATE friends SET status = 'accepted' WHERE id = ? AND friend_id = ?";
    
    db.query(sql, [request_id, req.user.id], (err, result) => {
        if (err) return res.status(500).json({ error: "خطأ في القاعدة" });
        res.status(200).json({ message: "تم قبول الصداقة" });
    });
});

app.listen(PORT, () => console.log(`Server on port ${PORT}`));