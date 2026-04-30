require('dotenv').config(); // تحميل الإعدادات من env
const express = require('express');
const mysql = require('mysql2');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs'); 
const cors = require('cors');
const path = require('path'); // مكتبة للتعامل مع المسارات

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(cors());

// السطر السحري: هذا السطر يخبر السيرفر بعرض أي ملف داخل مجلد public تلقائياً
app.use(express.static(path.join(__dirname, 'public'))); 

const SECRET = process.env.JWT_SECRET || 'falcon_secret_key';
const PORT = process.env.PORT || 3000;

// 1. إعداد قاعدة البيانات[cite: 1]
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
});

function initTables() {
    const tableUsers = `CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) UNIQUE,
        password VARCHAR(255)
    )`;
    const tableFriends = `CREATE TABLE IF NOT EXISTS friends (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT, friend_id INT
    )`;
    const tableMessages = `CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sender_id INT, receiver_id INT,
        message TEXT, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`;
    db.query(tableUsers);
    db.query(tableFriends);
    db.query(tableMessages);
}

db.connect(function(err) {
    if (err) return console.error('DB Error:', err);
    console.log('Connected to Database ✅');
    initTables(); 
});

// 2. مسارات الـ API[cite: 1]
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE username = ?', [username], async (err, results) => {
        if (err || results.length === 0) return res.status(401).json({ error: 'User not found' });
        const match = await bcrypt.compare(password, results[0].password);
        if (match) {
            const token = jwt.sign({ id: results[0].id, username: results[0].username }, SECRET);
            res.json({ token: token, user: { id: results[0].id, username: results[0].username } });
        } else {
            res.status(401).json({ error: 'Wrong password' });
        }
    });
});

// مسار افتراضي لفتح صفحة اللوجن إذا دخل الشخص للرابط الرئيسي[cite: 1]
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// 3. نظام Socket.io[cite: 1]
let onlineUsers = {};
io.on('connection', (socket) => {
    socket.on('register_socket', (userId) => { onlineUsers[userId] = socket.id; });
    socket.on('send_message', (data) => {
        db.query('INSERT INTO messages (sender_id, receiver_id, message) VALUES (?, ?, ?)', [data.sender_id, data.receiver_id, data.message]);
        if (onlineUsers[data.receiver_id]) io.to(onlineUsers[data.receiver_id]).emit('receive_message', data);
    });
});

server.listen(PORT, () => { console.log(`Server running on port ${PORT} 🚀`); });