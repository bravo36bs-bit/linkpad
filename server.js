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
const io = new Server(server, {
    cors: { origin: "*" }
});

const JWT_SECRET = process.env.JWT_SECRET || 'linkpad_super_secret_key';
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static('public'));

// --- نظام السوكيت (Socket.io) ---
io.on('connection', (socket) => {
    console.log('📡 محاولة اتصال بالسوكيت...');

    socket.on('join_room', (data) => {
        const { userId, token } = data;
        if (token) {
            socket.join(userId.toString());
            console.log(`✅ المستخدم ${userId} دخل غرفته بنجاح`);
        }
    });

    socket.on('send_message', (data) => {
        if (data.receiverId) {
            io.to(data.receiverId.toString()).emit('receive_message', data);
        }
    });
});

// --- الاتصال بقاعدة البيانات (التعديل الجوهري هنا) ---
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME || 'defaultdb',
    port: process.env.DB_PORT || 3306,
    ssl: { 
        rejectUnauthorized: false // ضروري جداً لـ Aiven
    },
    connectTimeout: 20000 // زيادة وقت المحاولة لتجنب الـ Fatal Error
});

db.connect((err) => {
    if (err) {
        console.error('❌ Database Connection Failed:', err.message);
        return;
    }
    console.log("✅ Connected to Aiven MySQL Successfully!");
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

    db.query(usersTable, (err) => {
        if (err) console.error("Error creating users table:", err);
        db.query(friendsTable, (err) => {
            if (err) console.error("Error creating friends table:", err);
            db.query(messagesTable, (err) => {
                if (err) console.error("Error creating messages table:", err);
                console.log("🚀 LinkPad Engine Ready.");
            });
        });
    });
};

// --- Middleware ---
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

// --- المسارات (Routes) ---

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "بيانات ناقصة" });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.query('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword], (err) => {
            if (err) {
                console.error("Registration DB Error:", err);
                if (err.code === 'ER_DUP_ENTRY') {
                    return res.status(400).json({ error: "اسم المستخدم موجود مسبقاً" });
                }
                return res.status(500).json({ error: "فشل في الاتصال بالسيرفر" });
            }
            res.status(200).json({ message: "Success" });
        });
    } catch (error) { 
        res.status(500).json({ error: "Internal Server Error" }); 
    }
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE username = ?', [username], async (err, results) => {
        if (err) return res.status(500).json({ error: "خطأ في قاعدة البيانات" });
        if (results.length === 0) return res.status(401).json({ error: "المستخدم غير موجود" });
        
        const isMatch = await bcrypt.compare(password, results[0].password);
        if (!isMatch) return res.status(401).json({ error: "كلمة المرور خاطئة" });
        
        const token = jwt.sign({ id: results[0].id, username: results[0].username }, JWT_SECRET);
        res.json({ token });
    });
});

app.get('/search-user', authenticateToken, (req, res) => {
    const query = req.query.query;
    db.query("SELECT id, username FROM users WHERE username = ? AND id != ?", [query, req.user.id], (err, results) => {
        if (err) return res.status(500).json({ error: "خطأ في البحث" });
        if (results.length > 0) res.json(results[0]);
        else res.status(404).json({ error: "لم يتم العثور على المستخدم" });
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

app.post('/send-friend-request', authenticateToken, (req, res) => {
    const { friend_id } = req.body;
    if (req.user.id == friend_id) return res.status(400).json({ error: "لا يمكنك إضافة نفسك" });

    const sql = "INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, 'pending')";
    db.query(sql, [req.user.id, friend_id], (err) => {
        if (err) return res.status(400).json({ error: "الطلب موجود بالفعل أو حدث خطأ" });
        res.status(200).json({ message: "تم إرسال الطلب" });
    });
});

app.post('/accept-friend', authenticateToken, (req, res) => {
    const { request_id } = req.body;
    const sql = "UPDATE friends SET status = 'accepted' WHERE id = ? AND friend_id = ?";
    db.query(sql, [request_id, req.user.id], (err) => {
        if (err) return res.status(500).json({ error: "فشل القبول" });
        res.status(200).json({ message: "تم القبول" });
    });
});

app.get('/get-messages/:friendId', authenticateToken, (req, res) => {
    const userId = req.user.id;
    const friendId = req.params.friendId;
    const sql = `SELECT * FROM private_messages 
                 WHERE (sender_id = ? AND receiver_id = ?) 
                 OR (sender_id = ? AND receiver_id = ?) 
                 ORDER BY created_at ASC`;
    db.query(sql, [userId, friendId, friendId, userId], (err, results) => {
        if (err) return res.status(500).json({ error: "خطأ في جلب الرسائل" });
        res.json(results);
    });
});

app.post('/send-private-message', authenticateToken, (req, res) => {
    const { receiver_id, message } = req.body;
    if (!message || !receiver_id) return res.status(400).send("بيانات ناقصة");
    const sql = "INSERT INTO private_messages (sender_id, receiver_id, content) VALUES (?, ?, ?)";
    db.query(sql, [req.user.id, receiver_id, message], (err) => {
        if (err) return res.status(500).json({ error: "فشل الإرسال" });
        res.status(200).json({ message: "تم الإرسال" });
    });
});

// تشغيل السيرفر باستخدام الكائن server وليس app لدعم Socket.io
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
    ---------------------------------------------------
    🚀 LinkPad Server is Live!
    🌐 Port: ${PORT}
    📡 Socket.io Ready
    ✅ Monitoring Database Connection...
    🌍 Binding: 0.0.0.0 (Public Access Ready)
    ---------------------------------------------------
    `);
});