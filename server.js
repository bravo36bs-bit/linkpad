const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());


const SECRET_KEY = process.env.JWT_SECRET;
// الاتصال بقاعدة البيانات
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: 'defaultdb',
    port: process.env.DB_PORT || 12345, // البورت الخاص بك
    ssl: { rejectUnauthorized: false }
});

// مسار تجريبي للتأكد أن السيرفر يعمل
app.get('/', (req, res) => res.send("LinkPad Server Active!"));

// تسجيل الدخول
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (err, results) => {
        if (results && results.length > 0) {
            const token = jwt.sign({ id: results[0].id, username: results[0].username }, JWT_SECRET);
            res.json({ token });
        } else {
            res.status(401).json({ error: "خطأ في البيانات" });
        }
    });
});

// جلب الرسائل بين شخصين
app.get('/messages/:myId/:friendId', (req, res) => {
    const { myId, friendId } = req.params;
    const q = 'SELECT * FROM messages WHERE (sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?) ORDER BY id ASC';
    db.query(q, [myId, friendId, friendId, myId], (err, results) => {
        res.json(results);
    });
});

// إرسال رسالة
app.post('/send', (req, res) => {
    const { sender_id, receiver_id, content } = req.body;
    db.query('INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)', [sender_id, receiver_id, content], (err) => {
        res.json({ success: true });
    });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server Running..."));