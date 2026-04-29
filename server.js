const express = require('express');
const path = require('path');
const mysql = require('mysql2');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SECRET_KEY = process.env.JWT_SECRET;

// الاتصال بقاعدة البيانات
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: 'defaultdb',
    port: process.env.DB_PORT || 12345,
    ssl: { rejectUnauthorized: false }
});

db.connect((err) => {
    if (err) {
        console.error('خطأ في الاتصال بقاعدة البيانات:', err.message);
        return;
    }
    console.log('متصل بقاعدة البيانات ✅');

    // إنشاء جدول المستخدمين إذا ما موجود
    db.query(`
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            password VARCHAR(255) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // إنشاء جدول الرسائل إذا ما موجود
    db.query(`
        CREATE TABLE IF NOT EXISTS messages (
            id INT AUTO_INCREMENT PRIMARY KEY,
            sender_id INT NOT NULL,
            receiver_id INT NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
});

// ===== Middleware للتحقق من التوكن =====
function verifyToken(req, res, next) {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ error: 'لا يوجد توكن' });
    try {
        const decoded = jwt.verify(token, SECRET_KEY);
        req.user = decoded;
        next();
    } catch (e) {
        res.status(401).json({ error: 'توكن غير صالح' });
    }
}

// ===== المسارات =====

// السيرفر شغال
app.get('/', (req, res) => res.send("LinkPad Server Active! ✅"));

// فحص الاتصال
app.get('/status', (req, res) => res.json({ status: 'ok' }));

// تسجيل مستخدم جديد
app.post('/signup', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password)
        return res.status(400).json({ error: 'اسم المستخدم وكلمة السر مطلوبان' });

    db.query('INSERT INTO users (username, password) VALUES (?, ?)', [username, password], (err) => {
        if (err) {
            if (err.code === 'ER_DUP_ENTRY')
                return res.status(400).json({ error: 'اسم المستخدم مستخدم مسبقاً' });
            return res.status(500).json({ error: 'خطأ بالسيرفر' });
        }
        res.json({ success: true, message: 'تم إنشاء الحساب بنجاح' });
    });
});

// تسجيل الدخول
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password)
        return res.status(400).json({ error: 'اسم المستخدم وكلمة السر مطلوبان' });

    db.query('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (err, results) => {
        if (err) return res.status(500).json({ error: 'خطأ بالسيرفر' });
        if (results && results.length > 0) {
            const token = jwt.sign(
                { id: results[0].id, username: results[0].username },
                SECRET_KEY,
                { expiresIn: '7d' }
            );
            res.json({ token });
        } else {
            res.status(401).json({ error: 'خطأ في اسم المستخدم أو كلمة السر' });
        }
    });
});

// جلب كل المستخدمين (عشان تختار من تدردش معه)
app.get('/users', verifyToken, (req, res) => {
    db.query('SELECT id, username FROM users WHERE id != ?', [req.user.id], (err, results) => {
        if (err) return res.status(500).json({ error: 'خطأ بالسيرفر' });
        res.json(results);
    });
});

// جلب الرسائل بين شخصين
app.get('/messages/:friendId', verifyToken, (req, res) => {
    const myId = req.user.id;
    const { friendId } = req.params;
    const q = `SELECT * FROM messages 
               WHERE (sender_id=? AND receiver_id=?) 
               OR (sender_id=? AND receiver_id=?) 
               ORDER BY id ASC`;
    db.query(q, [myId, friendId, friendId, myId], (err, results) => {
        if (err) return res.status(500).json({ error: 'خطأ بالسيرفر' });
        res.json(results);
    });
});

// ===== Socket.io للدردشة الفورية =====
const onlineUsers = {}; // { userId: socketId }

io.on('connection', (socket) => {
    console.log('مستخدم اتصل:', socket.id);

    // تسجيل المستخدم
    socket.on('register', (userId) => {
        onlineUsers[userId] = socket.id;
        console.log(`المستخدم ${userId} متصل`);
    });

    // إرسال رسالة
    socket.on('send_message', (data) => {
        const { sender_id, receiver_id, content } = data;

        // حفظ الرسالة بقاعدة البيانات
        db.query(
            'INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)',
            [sender_id, receiver_id, content],
            (err, result) => {
                if (err) return;

                const message = {
                    id: result.insertId,
                    sender_id,
                    receiver_id,
                    content,
                    created_at: new Date()
                };

                // إرسال للمرسل
                socket.emit('receive_message', message);

                // إرسال للمستقبل لو متصل
                const receiverSocket = onlineUsers[receiver_id];
                if (receiverSocket) {
                    io.to(receiverSocket).emit('receive_message', message);
                }
            }
        );
    });

    // قطع الاتصال
    socket.on('disconnect', () => {
        for (const userId in onlineUsers) {
            if (onlineUsers[userId] === socket.id) {
                delete onlineUsers[userId];
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`السيرفر يعمل على البورت ${PORT} ✅`));