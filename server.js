const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const SECRET_KEY = process.env.JWT_SECRET;

const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: 'defaultdb',
    port: process.env.DB_PORT || 12345,
    ssl: { rejectUnauthorized: false }
});

db.connect((err) => {
    if (err) { console.error('خطأ:', err.message); return; }
    console.log('متصل بقاعدة البيانات ✅');

    db.query(`CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    db.query(`CREATE TABLE IF NOT EXISTS friends (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        friend_id INT NOT NULL,
        status ENUM('pending', 'accepted', 'rejected') DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (friend_id) REFERENCES users(id)
    )`);

    db.query(`CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sender_id INT NOT NULL,
        receiver_id INT NOT NULL,
        content TEXT NOT NULL,
        is_seen TINYINT DEFAULT 0,
        deleted_by_sender TINYINT DEFAULT 0,
        deleted_by_receiver TINYINT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
});

// ===== Middleware =====
function verifyToken(req, res, next) {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ error: 'لا يوجد توكن' });
    try {
        req.user = jwt.verify(token, SECRET_KEY);
        next();
    } catch { res.status(401).json({ error: 'توكن غير صالح' }); }
}

// ===== المسارات =====
app.get('/', (req, res) => res.send("LinkPad Server Active! ✅"));
app.get('/status', (req, res) => res.json({ status: 'ok' }));

// تسجيل حساب جديد
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
        res.json({ success: true });
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

// البحث عن مستخدم
app.get('/search/:username', verifyToken, (req, res) => {
    const { username } = req.params;
    db.query(
        'SELECT id, username FROM users WHERE username LIKE ? AND id != ?',
        [`%${username}%`, req.user.id],
        (err, results) => {
            if (err) return res.status(500).json({ error: 'خطأ بالسيرفر' });
            res.json(results);
        }
    );
});

// إرسال طلب صداقة
app.post('/friend-request', verifyToken, (req, res) => {
    const { friend_id } = req.body;
    const user_id = req.user.id;

    db.query(
        'SELECT * FROM friends WHERE (user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)',
        [user_id, friend_id, friend_id, user_id],
        (err, results) => {
            if (err) return res.status(500).json({ error: 'خطأ بالسيرفر' });
            if (results.length > 0)
                return res.status(400).json({ error: 'طلب صداقة موجود مسبقاً' });

            db.query('INSERT INTO friends (user_id, friend_id) VALUES (?, ?)', [user_id, friend_id], (err) => {
                if (err) return res.status(500).json({ error: 'خطأ بالسيرفر' });
                const receiverSocket = onlineUsers[friend_id];
                if (receiverSocket) {
                    io.to(receiverSocket).emit('friend_request', {
                        from_id: user_id,
                        from_username: req.user.username
                    });
                }
                res.json({ success: true });
            });
        }
    );
});

// جلب طلبات الصداقة الواردة
app.get('/friend-requests', verifyToken, (req, res) => {
    db.query(
        `SELECT friends.id, users.id as user_id, users.username 
         FROM friends JOIN users ON friends.user_id = users.id 
         WHERE friends.friend_id = ? AND friends.status = 'pending'`,
        [req.user.id],
        (err, results) => {
            if (err) return res.status(500).json({ error: 'خطأ بالسيرفر' });
            res.json(results);
        }
    );
});

// قبول أو رفض طلب صداقة
app.post('/friend-response', verifyToken, (req, res) => {
    const { request_id, action } = req.body;
    db.query(
        'UPDATE friends SET status = ? WHERE id = ? AND friend_id = ?',
        [action, request_id, req.user.id],
        (err) => {
            if (err) return res.status(500).json({ error: 'خطأ بالسيرفر' });
            res.json({ success: true });
        }
    );
});

// جلب الأصدقاء المقبولين
app.get('/friends', verifyToken, (req, res) => {
    const myId = req.user.id;
    db.query(
        `SELECT users.id, users.username FROM friends 
         JOIN users ON (
             (friends.user_id = ? AND friends.friend_id = users.id) OR
             (friends.friend_id = ? AND friends.user_id = users.id)
         )
         WHERE (friends.user_id = ? OR friends.friend_id = ?) 
         AND friends.status = 'accepted'`,
        [myId, myId, myId, myId],
        (err, results) => {
            if (err) return res.status(500).json({ error: 'خطأ بالسيرفر' });
            res.json(results);
        }
    );
});

// جلب الرسائل بين شخصين
app.get('/messages/:friendId', verifyToken, (req, res) => {
    const myId = req.user.id;
    const { friendId } = req.params;
    const q = `SELECT * FROM messages 
               WHERE ((sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?))
               AND NOT (sender_id=? AND deleted_by_sender=1)
               AND NOT (receiver_id=? AND deleted_by_receiver=1)
               ORDER BY id ASC`;
    db.query(q, [myId, friendId, friendId, myId, myId, myId], (err, results) => {
        if (err) return res.status(500).json({ error: 'خطأ بالسيرفر' });
        db.query('UPDATE messages SET is_seen = 1 WHERE sender_id = ? AND receiver_id = ? AND is_seen = 0', [friendId, myId]);
        res.json(results);
    });
});

// حذف رسالة
app.delete('/message/:id', verifyToken, (req, res) => {
    const myId = req.user.id;
    const { id } = req.params;
    db.query('SELECT * FROM messages WHERE id = ?', [id], (err, results) => {
        if (err || !results.length) return res.status(404).json({ error: 'الرسالة غير موجودة' });
        const msg = results[0];
        if (msg.sender_id == myId) {
            db.query('UPDATE messages SET deleted_by_sender = 1 WHERE id = ?', [id]);
        } else if (msg.receiver_id == myId) {
            db.query('UPDATE messages SET deleted_by_receiver = 1 WHERE id = ?', [id]);
        }
        const otherId = msg.sender_id == myId ? msg.receiver_id : msg.sender_id;
        const otherSocket = onlineUsers[otherId];
        if (otherSocket) io.to(otherSocket).emit('message_deleted', { id });
        res.json({ success: true });
    });
});

// ===== Socket.io =====
const onlineUsers = {};

io.on('connection', (socket) => {
    socket.on('register', (userId) => {
        onlineUsers[userId] = socket.id;
    });

    socket.on('send_message', (data) => {
        const { sender_id, receiver_id, content } = data;
        db.query(
            'INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)',
            [sender_id, receiver_id, content],
            (err, result) => {
                if (err) return;
                const message = { id: result.insertId, sender_id, receiver_id, content, is_seen: 0, created_at: new Date() };
                socket.emit('receive_message', message);
                const receiverSocket = onlineUsers[receiver_id];
                if (receiverSocket) io.to(receiverSocket).emit('receive_message', message);
            }
        );
    });

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