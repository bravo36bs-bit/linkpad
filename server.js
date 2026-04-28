const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2');
require('dotenv').config();
const path = require('path');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);

// --- إعدادات السوكيت المحدثة ---
const io = new Server(server, {
    cors: {
        origin: "*", // مهم جداً للـ APK
        methods: ["GET", "POST"]
    }
});

const JWT_SECRET = process.env.JWT_SECRET || 'linkpad_super_secret_key';
const PORT = process.env.PORT || 3000;

// --- إعدادات CORS المتقدمة (حل مشكلة فشل الاتصال) ---
app.use(cors({
    origin: true, 
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// --- المسارات الأساسية للـ PWA ---
app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'public', 'manifest.json')));
app.get('/sw.js', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sw.js')));
app.get('/linkpadimage.jpg', (req, res) => res.sendFile(path.join(__dirname, 'public', 'linkpadimage.jpg')));

// --- اتصال قاعدة البيانات (Aiven MySQL) ---
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME || 'defaultdb',
    port: process.env.DB_PORT || 3306,
    ssl: { rejectUnauthorized: false },
    connectTimeout: 30000 // زيادة المهلة لتجنب مشاكل الشبكة في الـ APK
});

db.connect((err) => {
    if (err) {
        console.error('❌ Database Connection Failed:', err.message);
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

    db.query(usersTable);
    db.query(friendsTable);
    db.query(messagesTable, () => console.log("🚀 LinkPad Engine Ready."));
};

// --- التوثيق (Authentication Middleware) ---
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

// --- نظام السوكيت ---
io.on('connection', (socket) => {
    socket.on('join_room', (data) => {
        const { userId } = data;
        if (userId) {
            socket.join(userId.toString());
            console.log(`✅ User ${userId} is Online`);
        }
    });

    socket.on('send_message', (data) => {
        if (data.receiverId) {
            io.to(data.receiverId.toString()).emit('receive_message', data);
        }
    });
});

// --- المسارات (Routes) ---

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "بيانات ناقصة" });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.query('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword], (err) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: "الاسم موجود" });
                return res.status(500).json({ error: "فشل السيرفر" });
            }
            res.status(200).json({ message: "Success" });
        });
    } catch (e) { res.status(500).json({ error: "Error" }); }
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    // إضافة Headers يدوية في الرد للتأكد من عبورها للـ WebViewer
    res.header("Access-Control-Allow-Credentials", "true");

    db.query('SELECT * FROM users WHERE username = ?', [username], async (err, results) => {
        if (err) return res.status(500).json({ error: "Database Error" });
        if (results.length === 0) return res.status(401).json({ error: "المستخدم غير موجود" });

        const isMatch = await bcrypt.compare(password, results[0].password);
        if (!isMatch) return res.status(401).json({ error: "كلمة المرور خاطئة" });

        const token = jwt.sign({ id: results[0].id, username: results[0].username }, JWT_SECRET, { expiresIn: '7d' });
        
        // إرسال الرد كـ JSON واضح وصريح
        return res.status(200).json({ 
            status: "success",
            token: token,
            userId: results[0].id,
            username: results[0].username
        });
    });
});

// بقية الـ Routes (Search, Friends, Messages) تتبع نفس النمط...
app.get('/get-friends', authenticateToken, (req, res) => {
    const sql = `SELECT users.id, users.username FROM friends 
                 JOIN users ON (friends.user_id = users.id OR friends.friend_id = users.id)
                 WHERE (friends.user_id = ? OR friends.friend_id = ?) 
                 AND users.id != ? AND friends.status = 'accepted'`;
    db.query(sql, [req.user.id, req.user.id, req.user.id], (err, rows) => {
        res.json(rows || []);
    });
});

app.get('/get-messages/:friendId', authenticateToken, (req, res) => {
    const sql = `SELECT * FROM private_messages 
                 WHERE (sender_id = ? AND receiver_id = ?) 
                 OR (sender_id = ? AND receiver_id = ?) 
                 ORDER BY created_at ASC`;
    db.query(sql, [req.user.id, req.params.friendId, req.params.friendId, req.user.id], (err, results) => {
        if (err) return res.status(500).json({ error: "Error" });
        res.json(results);
    });
});

// تشغيل السيرفر
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 LinkPad Server Running on Port ${PORT}`);
});