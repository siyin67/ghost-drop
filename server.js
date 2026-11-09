'use strict';

/**
 * ============================================================================
 *  阅后即焚 · P2P 私密聊天室 —— 后端核心（server.js）
 * ============================================================================
 *
 *  设计目标（与需求一一对应）
 *  1. 准入控制：整个服务只有一个「口令」（ACCESS_CODE），不写死在代码里 ——
 *     优先读环境变量，其次读文本文件，都没有就随机生成并打印到日志。
 *     创建房间、加入房间都必须带上正确口令，否则一切操作都做不了。
 *  2. 无持久化：房间、成员、最近 50 条消息全部只存在于本进程内存中，
 *     不写日志、不落磁盘、不接数据库。进程重启 = 数据归零。
 *  3. 阅后即焚：房间内最后一个 socket 断开时，立即 delete 该房间对象
 *     （消息、成员一起被垃圾回收），后续再用旧链接进入只会得到
 *     `room_not_found`，由前端决定是重建还是放弃。
 *  4. 文本流：Socket.io 中转；每条房间只保留最新 50 条，新加入者随 join ack
 *     一次性拿到历史（含文件卡片元数据，不含文件本体）。
 *  5. 安全过滤：广播前用极简 badWords 列表做替换，命中字符变成 *，
 *     并在消息里带 `filtered` 标记供前端提示。
 *  6. 配置解耦：ICE/STUN 不写死在前端，由 STUN_URLS 环境变量注入，
 *     前端通过 GET /api/config 拿到数组后再构建 RTCPeerConnection。
 *
 *  HTTP 接口
 *    GET /            单页应用（index.html，永不缓存）
 *    GET /healthz     健康检查（容器 healthcheck 用）
 *    GET /api/config  {stunUrls: string[]}  前端运行时配置
 *
 *  P2P 文件传输里服务器只有一个职责：**信令中继**，而且只在被请求时才工作。
 *    1) 发送方 file:announce 广播一张卡片（文件名 / 大小 / 哈希），此时没有任何 RTCPeerConnection；
 *    2) 接收方点「下载」 --request_transfer--> 服务器 --request_transfer--> 发送方；
 *    3) 发送方收到后**只针对这一个接收方**新建 RTCPeerConnection，双方通过 `signal`
 *       事件互换 offer / answer / candidate，文件字节走 DataChannel，不经过本服务器。
 *    所以这里对 signal 只做「同一个房间内」的路由校验，不解析 SDP 内容。
 *
 *  事件契约（Client -> Server）
 *    access:verify  {accessCode}                                ack: {ok} | {ok:false, error}
 *    room:create    {roomId, accessCode, userId, userName}      ack: JoinResult
 *    room:join      {roomId, accessCode, userId, userName}      ack: JoinResult
 *    room:leave     {}                                          ack: {ok:true}
 *    message:send   {text}                                      ack: {ok, id}
 *    typing         {isTyping}                                  无 ack
 *    file:announce    {fileId, name, size, mime, hash, hashKind} ack: {ok, id}
 *    request_transfer {fileId, transferId, senderId}            ack: {ok} | {ok:false, error}
 *    signal           {to, data}                                无 ack（纯中继）
 *
 *  事件契约（Server -> Client）
 *    message:new    Message
 *    room:members   {members: Member[]}
 *    room:notice    {id, kind, text, at}      临时系统提示（不入历史）
 *    request_transfer {fileId, transferId, receiverId, receiverName, from: Member}
 *    signal         {from, fromUserId, data}
 *    typing         {userId, userName, isTyping}
 * ============================================================================
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

/**
 * 读取项目根目录下的 .env（本地开发方便）。
 * 容器里通常通过 compose 的 environment 注入，不存在 .env 也没关系；
 * dotenv 没装时也不该让服务起不来，所以这里用 try 兜住。
 */
try {
  require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
} catch (error) {
  // dotenv 是可选依赖：没装就跳过，只用真实的环境变量
}

/** 带时间戳的日志（唯一输出通道：stdout；不落文件） */
const log = (...args) => console.log(new Date().toISOString(), ...args);

/* ==========================================================================
 * 一、常量与配置
 * ========================================================================== */

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

/* --------------------------------------------------------------------------
 * ICE / STUN 配置（架构解耦：写死的 STUN 抽到这里，前端只负责消费）
 *
 * 需求：从 STUN_URLS 读取，缺省 stun:stun.l.google.com:19302；
 *      逗号分隔可配多个，前端用 GET /api/config 拉取后动态构建 iceServers。
 *
 * 这样换 STUN（自建 coturn、Cloudflare、Twilio 的 TURN…）只改环境变量，
 * 不用重新构建前端，也不需要动一行代码。
 * -------------------------------------------------------------------------- */

const DEFAULT_STUN_URLS = ['stun:stun.l.google.com:19302'];
const MAX_STUN_URLS = 8; // 上限：iceServers 塞太多只会拖慢候选收集

/**
 * 把 "stun:a, stun:b" 解析成 ['stun:a', 'stun:b']。
 * 容错：空串、多余逗号、非 stun/stuns/turn 协议的项一律丢掉。
 * @param {string|undefined} raw
 * @returns {string[]}
 */
function parseStunUrls(raw) {
  const list = String(raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => /^(stuns?|turns?):[^\s,]+$/i.test(item));
  return list.length ? list.slice(0, MAX_STUN_URLS) : DEFAULT_STUN_URLS.slice();
}

const STUN_URLS = parseStunUrls(process.env.STUN_URLS);

const MAX_HISTORY = 50; // 每个房间只保留最新 50 条消息
const MAX_TEXT_LENGTH = 2000; // 单条文本上限（字符数）
const MAX_FILE_NAME_LENGTH = 120; // 文件名上限
const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 单文件 1GB 上限（前端装配 Blob 的内存上限保护）
const MAX_ROOMS = 1000; // 全局房间数上限，防止内存被刷爆
const MAX_MEMBERS_PER_ROOM = 50; // 单房间在线人数上限

/* --------------------------------------------------------------------------
 * 服务级访问口令（暗号）
 *
 * 需求：不输对暗号就不能使用这个服务（既不能创建也不能加入房间）。
 *      口令不能硬编码 —— 换口令不应该改代码。
 *
 * 解析顺序（谁先有值用谁）：
 *   1. 环境变量 ACCESS_CODE
 *   2. 文件 ACCESS_CODE_FILE（默认 <项目目录>/access-code.txt，取第一行非空内容）
 *   3. 都没有就随机生成一个，并打印到启动日志里（保证开箱即用）
 * -------------------------------------------------------------------------- */

const ACCESS_CODE_MAX_LENGTH = 128; // 口令长度上限，防超长输入打满内存
const CODE_FAILURE_LIMIT = 6; // 连续输错几次锁定
const CODE_LOCK_MS = 60 * 1000; // 锁定时长

/**
 * 读取口令。注意：这里不缓存、不写文件，只在进程启动时算一次。
 * @param {string} fromEnv 环境变量里的值
 * @param {string} filePath 口令文件路径
 * @returns {string}
 */
function resolveAccessCode(fromEnv, filePath) {
  if (fromEnv) {
    log('[gate] 服务口令来源：环境变量 ACCESS_CODE');
    return fromEnv;
  }

  try {
    const line = fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => item.length > 0);
    if (line) {
      log(`[gate] 服务口令来源：文件 ${filePath}`);
      return line;
    }
  } catch {
    // 文件不存在 / 没权限：继续走随机口令，不让启动失败
  }

  const generated = crypto.randomBytes(9).toString('base64url');
  log('============================================================');
  log('[gate] 未找到 ACCESS_CODE，已随机生成一个临时口令（重启即失效）：');
  log(`[gate]     ${generated}`);
  log('[gate] 想固定下来：在 compose.yaml 里设置 ACCESS_CODE，');
  log('[gate] 或者把口令写进项目根目录的 access-code.txt 再重启。');
  log('============================================================');
  return generated;
}

const ACCESS_CODE = resolveAccessCode(
  (process.env.ACCESS_CODE ?? '').trim(),
  (process.env.ACCESS_CODE_FILE ?? path.join(__dirname, 'access-code.txt')).trim(),
);

/** 房间号：强制 room_ 前缀 + 小写字母数字，例如 room_a1b2 */
const ROOM_ID_RE = /^room_[a-z0-9]{1,24}$/;
const ROOM_ID_MAX_RAW = 29; // 去掉前缀后最多 24 位，留出余量

/** userId 由前端随机生成（localStorage 持久化），这里只做格式校验 */
const USER_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

/** 极简敏感词表：够用就好，真实项目应换成可热更新的词库 */
const badWords = [
  '傻逼',
  '煞笔',
  '傻b',
  '操你妈',
  '草泥马',
  '你妈的',
  '去死',
  '他妈',
  '滚蛋',
  'shit',
  'fuck',
  'bitch',
  'nigger',
];

/** 预编译正则，避免每条消息都重新构造 */
const badWordMatchers = badWords.map(
  (word) => new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
);

/* ==========================================================================
 * 二、内存数据模型
 * ========================================================================== */

/**
 * @typedef {Object} Member
 * @property {string} socketId  当前 Socket 连接 id（信令寻址用，断线重连后会变）
 * @property {string} userId    前端 localStorage 里的稳定身份
 * @property {string} userName  昵称
 * @property {number} joinedAt  加入时间戳
 */

/**
 * @typedef {Object} Room
 * @property {string} id
 * @property {number} createdAt
 * @property {Map<string, Member>} members   socketId -> Member
 * @property {Array<Object>} messages        最新 MAX_HISTORY 条
 *
 * 注意：房间里**没有**暗号字段 —— 口令是服务级的（ACCESS_CODE），
 * 不属于任何房间，所以房间对象里没有任何密钥材料可供泄漏。
 */

/** @type {Map<string, Room>} 唯一的"数据库"——进程内存 */
const rooms = new Map();

/* ==========================================================================
 * 三、通用工具
 * ========================================================================== */

const randomId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('hex')}`;

/** 统一的失败响应 */
function fail(code, message) {
  return { ok: false, error: code, message };
}

/** 给 socket.io ack 用的安全回调（老客户端没传 ack 时不炸） */
const safeAck = (ack) => (typeof ack === 'function' ? ack : () => {});

/**
 * 滑动窗口限流：按 socket 维度记录时间戳。
 * @returns {boolean} true = 放行
 */
function allow(socket, key, max, windowMs) {
  const now = Date.now();
  socket.data.limits ??= {};
  const hits = (socket.data.limits[key] ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    socket.data.limits[key] = hits;
    return false;
  }
  hits.push(now);
  socket.data.limits[key] = hits;
  return true;
}

/**
 * 把用户输入的字符串整理成合法房间号：
 * "A1B2" -> "room_a1b2"，"room_a1b2!" -> "room_a1b2"
 * @returns {string|null}
 */
function normalizeRoomId(raw) {
  if (typeof raw !== 'string') return null;
  let id = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, ROOM_ID_MAX_RAW);
  if (!id) return null;
  if (!id.startsWith('room_')) id = `room_${id}`;
  return ROOM_ID_RE.test(id) ? id : null;
}

/** 昵称清洗：去控制字符/尖括号，压缩空白，按"字符"截断（避免劈开 emoji） */
function normalizeUserName(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, 20).join('');
}

/** 极简敏感词过滤：命中即整词替换成等长 *，并返回是否命中 */
function filterText(text) {
  let out = text;
  let filtered = false;
  for (const re of badWordMatchers) {
    out = out.replace(re, (match) => {
      filtered = true;
      return '*'.repeat(match.length);
    });
  }
  return { text: out, filtered };
}

/**
 * 定宽比较两段口令：先各自 sha256 成 32 字节再 timingSafeEqual。
 * 先哈希的好处：长度不同也不会让 timingSafeEqual 抛异常，
 * 同时比较耗时与口令内容、长度都无关（抗时序侧信道）。
 */
function sameSecret(input, expected) {
  if (typeof input !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(input, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

/** 当前 socket 还要被锁多少秒（0 = 没锁） */
function codeLockRemaining(socket) {
  const until = socket.data.codeLockUntil ?? 0;
  return until > Date.now() ? Math.ceil((until - Date.now()) / 1000) : 0;
}

/**
 * 校验服务口令。这是整个服务的唯一入口闸门：
 * 创建房间、加入房间、access:verify 三个入口都走这里。
 *
 * 连续输错 CODE_FAILURE_LIMIT 次锁定 CODE_LOCK_MS，
 * 锁定按 socket 维度记，避免同一个连接无限暴力试。
 * @returns {{ok: true} | {ok: false, error: string, message: string}}
 */
function checkAccessCode(socket, code) {
  const lockedFor = codeLockRemaining(socket);
  if (lockedFor > 0) {
    return fail('locked', `口令错误次数过多，请 ${lockedFor} 秒后再试`);
  }

  if (sameSecret(code, ACCESS_CODE)) {
    socket.data.codeFailures = 0;
    socket.data.codeLockUntil = 0;
    return { ok: true };
  }

  const failures = (socket.data.codeFailures ?? 0) + 1;
  if (failures >= CODE_FAILURE_LIMIT) {
    socket.data.codeFailures = 0;
    socket.data.codeLockUntil = Date.now() + CODE_LOCK_MS;
    return fail('locked', `口令错误次数过多，已锁定 ${CODE_LOCK_MS / 1000} 秒`);
  }

  socket.data.codeFailures = failures;
  const left = CODE_FAILURE_LIMIT - failures;
  return fail('bad_access_code', `服务口令不正确（再错 ${left} 次将锁定 ${CODE_LOCK_MS / 1000} 秒）`);
}

/** 统一校验客户端传来的口令字符串格式 */
function normalizeAccessCode(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw.trim();
  if (!code || code.length > ACCESS_CODE_MAX_LENGTH) return null;
  return code;
}

/* ==========================================================================
 * 四、房间生命周期
 * ========================================================================== */

function createRoom(roomId) {
  const room = {
    id: roomId,
    createdAt: Date.now(),
    members: new Map(),
    messages: [],
  };
  rooms.set(roomId, room);
  log('[room] 创建', roomId);
  return room;
}

/** 阅后即焚：删掉引用，等待 GC 回收消息与成员 */
function destroyRoom(room, reason) {
  if (!rooms.has(room.id)) return;
  rooms.delete(room.id);
  log('[room] 焚毁', room.id, `（${reason}，已清除 ${room.messages.length} 条消息）`);
}

function pushHistory(room, message) {
  room.messages.push(message);
  const overflow = room.messages.length - MAX_HISTORY;
  if (overflow > 0) room.messages.splice(0, overflow);
}

function memberList(room) {
  return [...room.members.values()]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map(({ socketId, userId, userName }) => ({ socketId, userId, userName }));
}

function broadcastMembers(room) {
  io.to(room.id).emit('room:members', { members: memberList(room) });
}

/**
 * 临时系统提示（不进历史记录）。
 * @param {string} [exceptSocketId] 不发给谁（自己加入/创建房间时不必提示自己）
 */
function broadcastNotice(room, text, kind = 'info', exceptSocketId) {
  const notice = { id: randomId('n'), kind, text, at: Date.now() };
  let target = io.to(room.id);
  if (exceptSocketId) target = target.except(exceptSocketId);
  target.emit('room:notice', notice);
}

/** 当前 socket 所在的房间（同时校验房间还在） */
function currentRoom(socket) {
  const roomId = socket.data.joinedRoomId;
  if (!roomId) return null;
  const room = rooms.get(roomId);
  if (!room) {
    socket.data.joinedRoomId = null;
    return null;
  }
  return room;
}

/**
 * 把 socket 放进房间（幂等：先离开旧房间）。
 * @returns {Member}
 */
function enterRoom(socket, room, { userId, userName }) {
  leaveRoom(socket, '切换房间');
  socket.data.joinedRoomId = room.id;
  socket.data.user = { userId, userName };
  socket.join(room.id);

  const member = { socketId: socket.id, userId, userName, joinedAt: Date.now() };
  room.members.set(socket.id, member);
  return member;
}

/**
 * 把 socket 从当前房间移除；若它是最后一人，则焚毁房间。
 */
function leaveRoom(socket, reason) {
  const roomId = socket.data.joinedRoomId;
  if (!roomId) return;
  socket.data.joinedRoomId = null;
  socket.leave(roomId);

  const room = rooms.get(roomId);
  if (!room) return;
  const member = room.members.get(socket.id);
  room.members.delete(socket.id);

  if (room.members.size === 0) {
    destroyRoom(room, reason);
    return;
  }
  if (member) {
    broadcastNotice(room, `${member.userName} 离开了房间`, 'leave');
    broadcastMembers(room);
  }
}

/* ==========================================================================
 * 五、入参校验
 * ========================================================================== */

/**
 * 解析 room:create / room:join 的公共参数。
 * 房间号、服务口令、身份三者缺一不可；口令只做「有没有/长不长」的格式校验，
 * 真正的比对在 checkAccessCode 里（带锁定逻辑与限流）。
 * @returns {{ok: true, roomId: string, accessCode: string, userId: string, userName: string} | {ok: false, error: string, message: string}}
 */
function readCredentials(payload) {
  const body = payload && typeof payload === 'object' ? payload : {};

  const roomId = normalizeRoomId(body.roomId);
  if (!roomId) return { ...fail('bad_room_id', '房间号格式不正确，示例：room_a1b2') };

  const accessCode = normalizeAccessCode(body.accessCode);
  if (!accessCode) return { ...fail('bad_access_format', '请先输入服务口令') };

  if (typeof body.userId !== 'string' || !USER_ID_RE.test(body.userId)) {
    return { ...fail('bad_user_id', '身份标识不合法，请刷新页面重试') };
  }

  const userName = normalizeUserName(body.userName);
  if (!userName) return { ...fail('bad_user_name', '请先设置一个昵称') };

  return { ok: true, roomId, accessCode, userId: body.userId, userName };
}

/* ==========================================================================
 * 六、HTTP 层（只托管一个 HTML，其余一律 404）
 * ========================================================================== */

const app = express();
app.disable('x-powered-by');

// 基础安全响应头（不引入 CSP，避免误伤 Tailwind CDN 的内联样式注入）
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

const INDEX_FILE = path.join(__dirname, 'index.html');

function serveIndex(_req, res) {
  // 页面永远不缓存：房间状态是内存里的，刷新必须重新拉取
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(INDEX_FILE, (err) => {
    if (err) {
      log('[http] 读取 index.html 失败', err.message);
      if (!res.headersSent) res.status(500).type('text/plain').send('index.html 缺失');
    }
  });
}

// 容器 healthcheck 用
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), rooms: rooms.size });
});

/**
 * 前端运行时配置（目前只有 ICE 服务器）。
 *
 * 为什么要走后端下发而不是前端写死：
 *   - STUN/TURN 换地址不用重新构建、甚至不用重启前端；
 *   - 将来要加 TURN 的 username/credential 时，这些凭据也不该出现在静态文件里。
 *
 * 注意：这里没有敏感信息（STUN 地址本身就是公开的），所以不加鉴权；
 *      但如果以后要下发 TURN 凭据，记得先过一遍口令校验 / 短时效签名。
 */
app.get('/api/config', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ stunUrls: STUN_URLS });
});

app.get('/', serveIndex);

// SPA 式回退：无扩展名的路径都交给前端（例如误加的 /room）
// 带扩展名的（*.js / *.css / *.png ...）直接 404，避免把 HTML 当静态资源返回
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (/\.[a-z0-9]{1,8}$/i.test(req.path)) return next();
  serveIndex(req, res);
});

app.use((_req, res) => {
  res.status(404).type('text/plain').send('Not Found');
});

/* ==========================================================================
 * 七、Socket.io 层
 * ========================================================================== */

const server = http.createServer(app);
const io = new Server(server, {
  // 允许前端直接 /socket.io/socket.io.js 加载客户端库（部署时不依赖外网 CDN）
  serveClient: true,
  pingInterval: 20000,
  pingTimeout: 25000,
  // 信令消息（SDP + candidate）都很小，256KB 已经非常宽裕
  maxHttpBufferSize: 256 * 1024,
});

io.on('connection', (socket) => {
  socket.data.joinedRoomId = null;
  socket.data.user = null;
  socket.data.limits = {};
  socket.data.codeFailures = 0; // 连续输错口令次数
  socket.data.codeLockUntil = 0; // 锁定截止时间戳
  socket.data.accessGranted = false; // 本连接是否已经验对过口令

  /* ---------------- 服务口令校验（首页闸门） ---------------- */
  socket.on('access:verify', (payload, rawAck) => {
    const ack = safeAck(rawAck);

    // 独立限流：防止有人拿这个接口当口令爆破入口
    if (!allow(socket, 'verifyAccess', 20, 60_000)) {
      return ack(fail('rate_limited', '尝试次数过多，请稍后再试'));
    }

    const code = normalizeAccessCode(payload && payload.accessCode);
    if (!code) return ack(fail('bad_access_format', '请输入服务口令'));

    const checked = checkAccessCode(socket, code);
    if (!checked.ok) return ack(checked);

    socket.data.accessGranted = true;
    ack({ ok: true });
  });

  /* ---------------- 创建房间（模式 A） ---------------- */
  socket.on('room:create', (payload, rawAck) => {
    const ack = safeAck(rawAck);

    if (!allow(socket, 'create', 5, 60_000)) {
      return ack(fail('rate_limited', '创建房间太频繁，请稍后再试'));
    }

    const creds = readCredentials(payload);
    if (!creds.ok) return ack(creds);

    // 口令闸门：没有正确口令，创建房间也不许
    const gate = checkAccessCode(socket, creds.accessCode);
    if (!gate.ok) return ack(gate);
    socket.data.accessGranted = true;

    if (rooms.size >= MAX_ROOMS) {
      return ack(fail('server_busy', '服务器房间数已达上限，请稍后再试'));
    }
    if (rooms.has(creds.roomId)) {
      // 前端收到 room_exists 会换一个随机房间号重试
      return ack(fail('room_exists', '房间号已被占用'));
    }

    const room = createRoom(creds.roomId);
    const member = enterRoom(socket, room, creds);

    ack({
      ok: true,
      roomId: room.id,
      self: { socketId: member.socketId, userId: member.userId, userName: member.userName },
      members: memberList(room),
      messages: room.messages,
    });

    broadcastMembers(room);
    broadcastNotice(room, `${member.userName} 创建了房间`, 'create', socket.id);
    log('[room] 加入', room.id, member.userName, `(${member.socketId})`);
  });

  /* ---------------- 加入房间（模式 B / C） ---------------- */
  socket.on('room:join', (payload, rawAck) => {
    const ack = safeAck(rawAck);

    const creds = readCredentials(payload);
    if (!creds.ok) return ack(creds);

    // 口令闸门：先过服务级口令，再谈房间是否存在
    const gate = checkAccessCode(socket, creds.accessCode);
    if (!gate.ok) return ack(gate);
    socket.data.accessGranted = true;

    const room = rooms.get(creds.roomId);
    if (!room) {
      // 阅后即焚：房间没人在线 = 已被销毁
      return ack(fail('room_not_found', '房间不存在，可能已经被焚毁'));
    }
    if (room.members.size >= MAX_MEMBERS_PER_ROOM) {
      return ack(fail('room_full', `房间人数已满（上限 ${MAX_MEMBERS_PER_ROOM} 人）`));
    }

    const member = enterRoom(socket, room, creds);

    ack({
      ok: true,
      roomId: room.id,
      self: { socketId: member.socketId, userId: member.userId, userName: member.userName },
      members: memberList(room),
      messages: room.messages,
    });

    broadcastMembers(room);
    broadcastNotice(room, `${member.userName} 加入了房间`, 'join', socket.id);
    log('[room] 加入', room.id, member.userName, `(${member.socketId})`);
  });

  /* ---------------- 主动离开 ---------------- */
  socket.on('room:leave', (_payload, rawAck) => {
    const ack = safeAck(rawAck);
    if (!currentRoom(socket)) return ack({ ok: true });
    leaveRoom(socket, '最后一人主动离开');
    ack({ ok: true });
  });

  /* ---------------- 文本消息 ---------------- */
  socket.on('message:send', (payload, rawAck) => {
    const ack = safeAck(rawAck);
    const room = currentRoom(socket);
    if (!room) return ack(fail('not_in_room', '你已不在房间中'));
    if (!allow(socket, 'message', 12, 10_000)) {
      return ack(fail('rate_limited', '发言太快了，慢一点'));
    }

    const rawText = payload && typeof payload.text === 'string' ? payload.text : '';
    const text = rawText.replace(/\s+$/, ''); // 去掉尾部空白，保留内部换行
    if (!text.trim()) return ack(fail('empty', '消息不能为空'));
    if (Array.from(text).length > MAX_TEXT_LENGTH) {
      return ack(fail('too_long', `单条消息最多 ${MAX_TEXT_LENGTH} 个字符`));
    }

    const user = socket.data.user;
    const { text: safeText, filtered } = filterText(text);
    const message = {
      id: randomId('m'),
      type: 'text',
      userId: user.userId,
      userName: user.userName,
      text: safeText,
      filtered,
      at: Date.now(),
    };

    pushHistory(room, message);
    io.to(room.id).emit('message:new', message); // 包括发送者自己，前端统一走广播渲染
    ack({ ok: true, id: message.id });
  });

  /* ---------------- 正在输入 ---------------- */
  socket.on('typing', (payload) => {
    const room = currentRoom(socket);
    if (!room) return;
    const isTyping = Boolean(payload && payload.isTyping);
    socket.to(room.id).emit('typing', {
      userId: socket.data.user.userId,
      userName: socket.data.user.userName,
      isTyping,
    });
  });

  /* ---------------- 文件卡片广播（只发元数据，不发文件本体） ---------------- */
  socket.on('file:announce', (payload, rawAck) => {
    const ack = safeAck(rawAck);
    const room = currentRoom(socket);
    if (!room) return ack(fail('not_in_room', '你已不在房间中'));
    if (!allow(socket, 'file', 10, 30_000)) {
      return ack(fail('rate_limited', '发送文件太频繁，请稍后再试'));
    }

    const body = payload && typeof payload === 'object' ? payload : {};
    const fileId = typeof body.fileId === 'string' ? body.fileId : '';
    if (!/^f_[A-Za-z0-9_-]{6,40}$/.test(fileId)) {
      return ack(fail('bad_file_id', '文件标识不合法'));
    }

    const name = typeof body.name === 'string'
      ? Array.from(body.name.replace(/[\u0000-\u001f]/g, '')).slice(0, MAX_FILE_NAME_LENGTH).join('')
      : '';
    if (!name) return ack(fail('bad_file_name', '文件名不合法'));

    const size = Number(body.size);
    if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_SIZE) {
      return ack(fail('bad_file_size', '文件大小超出限制（最大 1GB）'));
    }

    const mime = typeof body.mime === 'string' ? body.mime.slice(0, 100) : '';

    /**
     * 文件指纹：发送方在本地算好再广播，服务器只做格式校验。
     *   kind = 'sha256'  整份文件的 SHA-256（小文件）
     *   kind = 'sampled' 头/中/尾各 1MB + 字节数的 SHA-256（大文件，避免整份读进内存）
     * 接收方拼装完 Blob 后用同样的规则再算一次，对不上就提示校验失败。
     */
    const hash = typeof body.hash === 'string' && /^[a-f0-9]{64}$/.test(body.hash) ? body.hash : '';
    const hashKind = hash && (body.hashKind === 'sampled' ? 'sampled' : 'sha256');

    const user = socket.data.user;
    const message = {
      id: randomId('m'),
      type: 'file',
      userId: user.userId,
      userName: user.userName,
      filtered: false,
      file: { fileId, name, size, mime, hash, hashKind, senderSocketId: socket.id },
      at: Date.now(),
    };

    pushHistory(room, message);
    io.to(room.id).emit('message:new', message);
    ack({ ok: true, id: message.id });
  });

  /* ---------------- 传输请求：接收方 -> 发送方（按需建连的第一步） ----------------
   * 服务端在这条事件里只做三件事：鉴权、确认人还在、确认文件确实是这个人在
   * 这个房间里广播过的。**绝不碰 WebRTC**——真正的 RTCPeerConnection 由发送方
   * 收到请求后，针对这一个接收方单独创建。
   */
  socket.on('request_transfer', (payload, rawAck) => {
    const ack = safeAck(rawAck);
    const room = currentRoom(socket);
    if (!room) return ack(fail('not_in_room', '你已不在房间中'));
    if (!allow(socket, 'request_transfer', 20, 30_000)) {
      return ack(fail('rate_limited', '接收请求太频繁，请稍后再试'));
    }

    const body = payload && typeof payload === 'object' ? payload : {};
    const fileId = typeof body.fileId === 'string' ? body.fileId : '';
    const transferId = typeof body.transferId === 'string' ? body.transferId : '';
    const senderId = typeof body.senderId === 'string' ? body.senderId : '';

    if (!/^f_[A-Za-z0-9_-]{6,40}$/.test(fileId)) return ack(fail('bad_file_id', '文件标识不合法'));
    if (!/^t_[A-Za-z0-9_-]{6,40}$/.test(transferId)) return ack(fail('bad_transfer_id', '传输标识不合法'));
    if (!senderId || senderId === socket.id) return ack(fail('bad_peer', '发送方标识不合法'));
    if (!room.members.has(senderId)) return ack(fail('peer_offline', '发送方已离线，无法接收'));

    // 只允许请求「本房间里确实广播过」的文件，避免拿别人的 fileId 乱探
    const entry = room.messages.find((m) => m.type === 'file' && m.file && m.file.fileId === fileId);
    if (!entry) return ack(fail('file_expired', '这个文件已不在房间记录里（只保留最近 50 条）'));
    if (entry.file.senderSocketId && entry.file.senderSocketId !== senderId) {
      return ack(fail('bad_peer', '文件发送者不匹配'));
    }

    io.to(senderId).emit('request_transfer', {
      fileId,
      transferId,
      receiverId: socket.id,
      receiverName: socket.data.user.userName,
      from: {
        socketId: socket.id,
        userId: socket.data.user.userId,
        userName: socket.data.user.userName,
      },
    });
    ack({ ok: true });
  });

  /* ---------------- 信令中继（纯转发，不解析 SDP） ---------------- */
  socket.on('signal', (payload) => {
    const room = currentRoom(socket);
    if (!room) return;
    const body = payload && typeof payload === 'object' ? payload : {};
    const to = typeof body.to === 'string' ? body.to : '';
    const data = body.data && typeof body.data === 'object' ? body.data : null;
    if (!data || !room.members.has(to) || to === socket.id) return;
    // 信令是高频事件（每个 ICE candidate 一条），给一个宽松但存在的上限
    if (!allow(socket, 'signal', 500, 10_000)) return;

    io.to(to).emit('signal', {
      from: socket.id,
      fromUserId: socket.data.user.userId,
      data,
    });
  });

  /* ---------------- 断开连接 = 阅后即焚的触发点 ---------------- */
  socket.on('disconnect', (reason) => {
    const roomId = socket.data.joinedRoomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    socket.data.joinedRoomId = null;
    if (!room) return;

    const member = room.members.get(socket.id);
    room.members.delete(socket.id);

    if (room.members.size === 0) {
      destroyRoom(room, `最后一人离开：${member?.userName ?? socket.id} / ${reason}`);
      return;
    }
    if (member) {
      broadcastNotice(room, `${member.userName} 离开了房间`, 'leave');
      broadcastMembers(room);
    }
    log('[room] 离开', room.id, member?.userName ?? socket.id, `(${socket.id})`);
  });
});

/* ==========================================================================
 * 八、进程级兜底与优雅退出
 * ========================================================================== */

// 防御性清扫：正常流程不会留下 0 人房间，这里只是兜底
const sweeper = setInterval(() => {
  for (const [roomId, room] of rooms) {
    if (room.members.size === 0) destroyRoom(room, '定时清理空房间');
  }
}, 60_000);
sweeper.unref();

server.listen(PORT, HOST, () => {
  log(`[boot] 聊天室已启动 http://${HOST}:${PORT} （内存模式，不落盘）`);
  log('[boot] 准入：必须输入正确的服务口令才能创建/加入房间');
  log(`[boot] ICE：${STUN_URLS.length} 个 STUN（GET /api/config 下发）→ ${STUN_URLS.join(', ')}`);
});

function shutdown(signal) {
  log(`[exit] 收到 ${signal}，关闭服务`);
  clearInterval(sweeper);
  io.close();
  server.close(() => process.exit(0));
  // 兜底：5 秒内没退干净就强杀
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// 未捕获异常不应该静默带走整个聊天室，至少留下线索
process.on('unhandledRejection', (err) => log('[fatal] unhandledRejection', err));
