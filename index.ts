import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { createServer } from 'http';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import session from 'express-session';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

const secret = dotenv.config().parsed?.APP_SECRET;
const tokenSecret = dotenv.config().parsed?.TOKEN_SECRET;
const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(express.json());
app.use(
  session({
    secret: secret || '',
    cookie: { maxAge: 1000 * 60 * 60 * 24 },
    resave: true,
    saveUninitialized: true,
  })
);

const server = createServer(app);
const io = new Server(server, { cors: { origin: 'http://localhost:3000' } });
let savedRoom: string = '';
let targetUserId: string = '';
let senderId: string = '';
const users = new Map();
const sender = new Map();

io.on('connection', (socket) => {
  console.log('a user connected', socket.id);

  socket.on('login', (userId: any) => {
    console.log('logged in user: ', userId);
    users.set(userId, socket.id);
    sender.set(socket.id, userId);
  });

  socket.on('message', (data) => {
    console.log({ data, socketId: socket.id, senderId: sender.get(socket.id) });
    io.to(users.get(data.to)).emit('new_msg', {
      from: {
        senderSocketId: socket.id,
        senderId: sender.get(socket.id),
        room: data.to,
      },
      message: data.message,
    });
  });

  socket.on('disconnect', () => {
    for (const [userId, socketId] of users.entries()) {
      if (socketId === socket.id) {
        console.log(`User ${userId} disconnected`);
        users.delete(userId);
        break;
      }
    }
    savedRoom = '';
    targetUserId = '';
    senderId = '';
  });
});

app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  const salt = bcrypt.genSaltSync();
  const hash = bcrypt.hashSync(password, salt);

  if (username && hash) {
    const user = await prisma.user.findFirst({ where: { name: username } });

    if (user?.name === username) {
      res
        .status(401)
        .json({ ok: false, status: 401, message: 'User already exists' });
    } else {
      await prisma.user.create({
        data: {
          name: username,
          password: hash,
          id: uuidv4(),
        },
      });
      res.status(200).json({ ok: true });
    }
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.status(200).json({ ok: true }));
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  let token = '';
  (req.session as any).username = username;

  const user = await prisma.user.findFirst({ where: { name: username } });

  if (user) {
    const isMatch = await bcrypt.compare(password, user.password);
    console.log({ isMatch });
    if (isMatch) {
      token = jwt.sign({ id: user.id }, tokenSecret || '', {
        expiresIn: '24h',
      });

      res.status(200).json({
        ok: true,
        user,
        session: { sessionID: req.sessionID, session: req.session },
        token: token,
      });
    } else {
      res.status(401).json({ ok: false, message: 'Invalid password' });
    }
  } else {
    res.status(401).json({ ok: false, message: 'User not found' });
  }
});

app.get('/user', async (req, res) => {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).json({
      ok: false,
      message: 'Error!Token was not provided.',
    });
  }

  const decodedToken =
    token && jwt.verify(token.split(' ')[1], tokenSecret || '');

  const user = await prisma.user.findFirst({
    where: {
      id: (decodedToken as any).id,
    },
  });

  const friends = await prisma.friend.findMany({
    where: {
      userId: (decodedToken as any).id,
    },
  });

  if (user && friends)
    res.status(200).json({ ok: true, user: { ...user, friends } });
  else return res.status(401).json({ ok: false, message: 'User not found' });
});

app.post('/user', async (req, res) => {
  const { id } = req.body;
  console.log({ req: req.body });
  const user = await prisma.user.findUnique({ where: { id } });

  res.status(200).json({ ok: true, user });
});

app.post('/findUser', async (req, res) => {
  const { name } = req.body;
  const token = req.headers.authorization;

  const decodedToken =
    token && jwt.verify(token.split(' ')[1], tokenSecret || '');

  const user = await prisma.user.findFirst({ where: { name } });
  console.log({ user });

  res.status(200).json({ ok: true });
});
app.post('/addFriend', async (req, res) => {
  console.log({ req: req.body });
  await prisma.friend.create({
    data: {
      name: req.body.name,
      userId: req.body.userId,
      friendId: req.body.friendId,
    },
  });

  res.status(200).json({ ok: true });
});

app.get('/friends/:userId', async (req, res) => {
  const userId = req.params.userId;

  // Use Prisma to find friends for the specified userId
  const friends = await prisma.friend.findMany({
    where: {
      userId: userId,
    },
  });

  res.json(friends);
});

app.get('/messages', async (req, res) => {
  const messages = await prisma.user.findMany({});
  res.json(messages);
});

const PORT = 8080;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
