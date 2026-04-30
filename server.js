const express  = require('express');
const mysql    = require('mysql2');
const cors     = require('cors');
const jwt      = require('jsonwebtoken');
const http     = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const SECRET = process.env.JWT_SECRET;

// ─── قاعدة البيانات ───────────────────────────────────────────
const db = mysql.createConnection({
    host    : process.env.DB_HOST,
    user    : process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: 'falcondb',
    port    : process.env.DB_PORT || 3306,
    ssl     : { rejectUnauthorized: false }
});

db.connect(err => {
    if (err) { console.error('DB Error:', err.message); return; }
    console.log('Connected to DB ✅');
db.query(`SHOW COLUMNS FROM friends LIKE 'sender_id'`, (err, rows) => {

    if (!err && rows.length === 0) {
        db.query(`ALTER TABLE friends ADD COLUMN sender_id INT`);
        db.query(`ALTER TABLE friends ADD COLUMN receiver_id INT`);
}

});
});

function initTables() {
    db.query(`
        CREATE TABLE IF NOT EXISTS users (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            username   VARCHAR(50) UNIQUE NOT NULL,
            password   VARCHAR(255) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.query(`
        CREATE TABLE IF NOT EXISTS friends (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            sender_id   INT NOT NULL,
            receiver_id INT NOT NULL,
            status      ENUM('pending','accepted','rejected') DEFAULT 'pending',
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY unique_pair (sender_id, receiver_id),
            FOREIGN KEY (sender_id)   REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    db.query(`
        CREATE TABLE IF NOT EXISTS messages (
            id                  INT AUTO_INCREMENT PRIMARY KEY,
            sender_id           INT NOT NULL,
            receiver_id         INT NOT NULL,
            content             TEXT NOT NULL,
            is_seen             TINYINT DEFAULT 0,
            deleted_by_sender   TINYINT DEFAULT 0,
            deleted_by_receiver TINYINT DEFAULT 0,
            created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (sender_id)   REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);
}

// ─── Middleware ────────────────────────────────────────────────
function auth(req, res, next) {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ error: 'غير مصرح' });
    try {
        req.user = jwt.verify(token, SECRET);
        req.user.id = parseInt(req.user.id);
        next();
    } catch {
        res.status(401).json({ error: 'توكن غير صالح' });
    }
}

// ─── Helper ───────────────────────────────────────────────────
function query(sql, params) {
    return new Promise((resolve, reject) => {
        db.query(sql, params, (err, results) => {
            if (err) reject(err);
            else resolve(results);
        });
    });
}

// ═══════════════════════════════════════════════════════════════
//  المسارات
// ═══════════════════════════════════════════════════════════════

app.get('/',       (_, res) => res.send('Falcon Office Server Active ✅'));
app.get('/status', (_, res) => res.json({ status: 'ok' }));

// ── تسجيل حساب ────────────────────────────────────────────────
app.post('/signup', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password)
        return res.status(400).json({ error: 'اسم المستخدم وكلمة السر مطلوبان' });
    if (username.length < 3)
        return res.status(400).json({ error: 'اسم المستخدم يجب أن يكون 3 أحرف على الأقل' });
    if (password.length < 4)
        return res.status(400).json({ error: 'كلمة السر يجب أن تكون 4 أحرف على الأقل' });
    try {
        await query('INSERT INTO users (username, password) VALUES (?, ?)', [username, password]);
        res.json({ success: true });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY')
            return res.status(400).json({ error: 'اسم المستخدم مستخدم مسبقاً' });
        res.status(500).json({ error: 'خطأ بالسيرفر' });
    }
});

// ── تسجيل الدخول ──────────────────────────────────────────────
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password)
        return res.status(400).json({ error: 'اسم المستخدم وكلمة السر مطلوبان' });
    try {
        const rows = await query(
            'SELECT id, username FROM users WHERE username=? AND password=?',
            [username, password]
        );
        if (!rows.length)
            return res.status(401).json({ error: 'اسم المستخدم أو كلمة السر خاطئة' });
        const token = jwt.sign(
            { id: rows[0].id, username: rows[0].username },
            SECRET,
            { expiresIn: '7d' }
        );
        res.json({ token });
    } catch {
        res.status(500).json({ error: 'خطأ بالسيرفر' });
    }
});

// ── البحث عن مستخدم ───────────────────────────────────────────
app.get('/search', auth, async (req, res) => {
    const { q } = req.query;
    if (!q) return res.json([]);
    try {
        const rows = await query(
            'SELECT id, username FROM users WHERE username LIKE ? AND id != ? LIMIT 10',
            [`%${q}%`, req.user.id]
        );
        res.json(rows);
    } catch {
        res.status(500).json({ error: 'خطأ بالسيرفر' });
    }
});

// ── إرسال طلب صداقة ───────────────────────────────────────────
app.post('/friends/request', auth, async (req, res) => {
    const senderId   = parseInt(req.user.id);
    const receiverId = parseInt(req.body.receiver_id);

    if (!receiverId || isNaN(receiverId))
        return res.status(400).json({ error: 'معرف غير صالح' });
    if (receiverId === senderId)
        return res.status(400).json({ error: 'لا يمكنك إضافة نفسك' });

    try {
        const existing = await query(
            `SELECT id FROM friends
             WHERE (sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?)`,
            [senderId, receiverId, receiverId, senderId]
        );
        if (existing.length)
            return res.status(400).json({ error: 'طلب موجود مسبقاً أو أنتم أصدقاء' });

        await query(
            'INSERT INTO friends (sender_id, receiver_id) VALUES (?, ?)',
            [senderId, receiverId]
        );

        const sock = onlineUsers[receiverId];
        if (sock) {
            io.to(sock).emit('friend_request', {
                from_id: senderId,
                from_username: req.user.username
            });
        }
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'خطأ بالسيرفر' });
    }
});

// ── الرد على طلب صداقة ────────────────────────────────────────
app.post('/friends/respond', auth, async (req, res) => {
    const { request_id, action } = req.body;
    if (!['accepted', 'rejected'].includes(action))
        return res.status(400).json({ error: 'إجراء غير صالح' });
    try {
        const result = await query(
            'UPDATE friends SET status=? WHERE id=? AND receiver_id=? AND status="pending"',
            [action, request_id, req.user.id]
        );
        if (!result.affectedRows)
            return res.status(404).json({ error: 'الطلب غير موجود' });

        if (action === 'accepted') {
            const rows = await query('SELECT sender_id FROM friends WHERE id=?', [request_id]);
            if (rows.length) {
                const sock = onlineUsers[rows[0].sender_id];
                if (sock) io.to(sock).emit('friend_accepted', { by_username: req.user.username });
            }
        }
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'خطأ بالسيرفر' });
    }
});

// ── جلب طلبات الصداقة الواردة ─────────────────────────────────
app.get('/friends/requests', auth, async (req, res) => {
    try {
        const rows = await query(
            `SELECT f.id, u.id as user_id, u.username
             FROM friends f
             JOIN users u ON u.id = f.sender_id
             WHERE f.receiver_id=? AND f.status='pending'`,
            [req.user.id]
        );
        res.json(rows);
    } catch {
        res.status(500).json({ error: 'خطأ بالسيرفر' });
    }
});

// ── جلب قائمة الأصدقاء ────────────────────────────────────────
app.get('/friends', auth, async (req, res) => {
    const myId = parseInt(req.user.id);
    try {
        const rows = await query(
            `SELECT u.id, u.username
             FROM friends f
             JOIN users u ON u.id = IF(f.sender_id = ?, f.receiver_id, f.sender_id)
             WHERE (f.sender_id = ? OR f.receiver_id = ?)
               AND f.status = 'accepted'`,
            [myId, myId, myId]
        );
        res.json(rows);
    } catch (err) {
        console.error('friends error:', err);
        res.status(500).json({ error: 'خطأ بالسيرفر' });
    }
});

// ── جلب الرسائل بين شخصين فقط ────────────────────────────────
app.get('/messages/:friendId', auth, async (req, res) => {
    const myId     = parseInt(req.user.id);
    const friendId = parseInt(req.params.friendId);

    if (isNaN(friendId))
        return res.status(400).json({ error: 'معرف غير صالح' });

    try {
        const rows = await query(
            `SELECT id, sender_id, receiver_id, content, is_seen, created_at
             FROM messages
             WHERE ((sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?))
               AND NOT (sender_id=?   AND deleted_by_sender=1)
               AND NOT (receiver_id=? AND deleted_by_receiver=1)
             ORDER BY id ASC`,
            [myId, friendId, friendId, myId, myId, myId]
        );

        // علّم الرسائل الواردة كـ seen
        await query(
            'UPDATE messages SET is_seen=1 WHERE sender_id=? AND receiver_id=? AND is_seen=0',
            [friendId, myId]
        );

        // أشعر المُرسل
        const sock = onlineUsers[friendId];
        if (sock) io.to(sock).emit('messages_seen', { by: myId });

        res.json(rows);
    } catch {
        res.status(500).json({ error: 'خطأ بالسيرفر' });
    }
});

// ── حذف رسالة ─────────────────────────────────────────────────
app.delete('/messages/:id', auth, async (req, res) => {
    const myId  = parseInt(req.user.id);
    const msgId = parseInt(req.params.id);
    try {
        const rows = await query('SELECT * FROM messages WHERE id=?', [msgId]);
        if (!rows.length)
            return res.status(404).json({ error: 'الرسالة غير موجودة' });

        const msg = rows[0];
        if (msg.sender_id === myId) {
            await query('UPDATE messages SET deleted_by_sender=1 WHERE id=?', [msgId]);
        } else if (msg.receiver_id === myId) {
            await query('UPDATE messages SET deleted_by_receiver=1 WHERE id=?', [msgId]);
        } else {
            return res.status(403).json({ error: 'غير مصرح' });
        }

        const otherId = msg.sender_id === myId ? msg.receiver_id : msg.sender_id;
        const sock    = onlineUsers[otherId];
        if (sock) io.to(sock).emit('message_deleted', { id: msgId });

        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'خطأ بالسيرفر' });
    }
});

// ═══════════════════════════════════════════════════════════════
//  Socket.io
// ═══════════════════════════════════════════════════════════════
const onlineUsers = {};

io.on('connection', socket => {

    socket.on('register', userId => {
        onlineUsers[parseInt(userId)] = socket.id;
    });

    socket.on('send_message', async data => {
        const sender_id   = parseInt(data.sender_id);
        const receiver_id = parseInt(data.receiver_id);
        const content     = data.content;

        if (!sender_id || !receiver_id || !content) return;

        try {
            const result = await query(
                'INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)',
                [sender_id, receiver_id, content]
            );
            const message = {
                id: result.insertId,
                sender_id,
                receiver_id,
                content,
                is_seen   : 0,
                created_at: new Date()
            };

            // أرسل للمرسل فقط
            socket.emit('receive_message', message);

            // أرسل للمستقبل فقط إن كان متصل
            const receiverSock = onlineUsers[receiver_id];
            if (receiverSock) {
                io.to(receiverSock).emit('receive_message', message);
            }
        } catch (err) {
            console.error('send_message error:', err);
        }
    });

    socket.on('disconnect', () => {
        for (const uid in onlineUsers) {
            if (onlineUsers[uid] === socket.id) {
                delete onlineUsers[uid];
                break;
            }
        }
    });
});

// ─── تشغيل ────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Falcon Office running on port ${PORT} ✅`));