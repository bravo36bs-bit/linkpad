require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs'); 
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(cors());

const SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 3000;

// 1. إعداد قاعدة البيانات
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
});

// 2. دالة إنشاء الجداول تلقائياً
function initTables() {
    const tableUsers = `CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) UNIQUE,
        password VARCHAR(255)
    )`;

    const tableFriends = `CREATE TABLE IF NOT EXISTS friends (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        friend_id INT
    )`;

    const tableMessages = `CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sender_id INT,
        receiver_id INT,
        message TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`;

    db.query(tableUsers);
    db.query(tableFriends);
    db.query(tableMessages);
    console.log("Database Tables Initialized ✅");
}

db.connect(function(err) {
    if (err) {
        console.error('DB Connection Error:', err);
        return;
    }
    console.log('Connected to MySQL ✅');
    initTables(); 
});

// 3. Middleware للمصادقة (نسخة مستقرة)
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    let token = null;

    if (authHeader) {
        if (authHeader.startsWith('Bearer ')) {
            token = authHeader.split(' ')[1];
        } else {
            token = authHeader;
        }
    }

    if (token === null) {
        return res.status(401).json({ error: 'Access denied' });
    }

    jwt.verify(token, SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid token' });
        }
        req.user = user;
        next();
    });
};

// 4. مسارات تسجيل الدخول
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.query('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword], (err) => {
            if (err) return res.status(400).json({ error: 'User exists' });
            res.json({ success: true });
        });
    } catch (e) {
        res.status(500).json({ error: 'Error' });
    }
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE username = ?', [username], async (err, results) => {
        if (err || results.length === 0) return res.status(401).json({ error: 'Not found' });
        
        const user = results[0];
        const match = await bcrypt.compare(password, user.password);
        
        if (match) {
            const token = jwt.sign({ id: user.id, username: user.username }, SECRET);
            res.json({ token: token, user: { id: user.id, username: user.username } });
        } else {
            res.status(401).json({ error: 'Wrong password' });
        }
    });
});

// 5. جلب الأصدقاء[cite: 1]
app.get('/friends', authenticateToken, (req, res) => {
    const sql = `SELECT users.id, users.username FROM users 
                 JOIN friends ON users.id = friends.friend_id 
                 WHERE friends.user_id = ?`;
    db.query(sql, [req.user.id], (err, results) => {
        if (err) return res.status(500).json(err);
        res.json(results);
    });
});

// 6. نظام Socket.io (المصحح من الصورة)[cite: 1]
let onlineUsers = {};

io.on('connection', (socket) => {
    socket.on('register_socket', (userId) => {
        onlineUsers[userId] = socket.id;
        console.log('User registered:', userId);
    });

    socket.on('send_message', (data) => {
        const { sender_id, receiver_id, message } = data;
        db.query('INSERT INTO messages (sender_id, receiver_id, message) VALUES (?, ?, ?)', 
            [sender_id, receiver_id, message]);

        const targetSocketId = onlineUsers[receiver_id];
        if (targetSocketId) {
            io.to(targetSocketId).emit('receive_message', data);
        }
    });

    socket.on('disconnect', () => {
        for (const userId in onlineUsers) {
            if (onlineUsers[userId] === socket.id) {
                delete onlineUsers[userId];
                console.log('User disconnected:', userId);
                break;
            }
        }
    });
});

server.listen(3000, () => {
    console.log('Falcon Office Server is active on port 3000 🚀');
});