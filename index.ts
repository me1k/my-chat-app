import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { createServer } from 'http';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import session from 'express-session';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';

const tokenSecret = dotenv.config().parsed?.TOKEN_SECRET;
const refreshTokenSecret = dotenv.config().parsed?.REFRESH_TOKEN_SECRET;
const prisma = new PrismaClient();
const app = express();

app.use(cors({ origin: 'http://localhost:3000', credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(cookieParser());

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

  socket.on('message', async (data) => {
    const senderId = sender.get(socket.id);
    const receiverId = data.to;

    try {
      // Check if sender and receiver are friends
      const existingFriendshipSender = await prisma.friend.findFirst({
        where: {
          userId: senderId,
          friendId: receiverId,
        },
      });

      const existingFriendshipReceiver = await prisma.friend.findFirst({
        where: {
          userId: receiverId,
          friendId: senderId,
        },
      });

      // If sender and receiver are not friends, handle the error or return
      if (!existingFriendshipSender || !existingFriendshipReceiver) {
        console.error('Sender and receiver are not friends.');
        // Handle the error or return early
        return;
      }

      const friendIdFromSender = existingFriendshipReceiver?.id;
      const friendIdFromReceiver = existingFriendshipSender?.id;

      await prisma.message.create({
        data: {
          content: data.message,
          published: true,
          user: { connect: { id: senderId } },
          friend: { connect: { id: friendIdFromReceiver } }, // Connect to the receiver's friendship record
        },
      });

      // Emit the new message to the receiver
      io.to(users.get(data.to)).emit('new_msg', {
        from: {
          senderSocketId: socket.id,
          senderId,
          room: receiverId,
        },
        message: data.message,
      });
    } catch (error) {
      console.error('Error creating message:', error);
      // Handle the error
    }
    // io.to(users.get(data.to)).emit('new_msg', {
    //   from: {
    //     senderSocketId: socket.id,
    //     senderId,
    //     room: receiverId,
    //   },
    //   message: data.message,
    // });
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
        },
      });
      res.status(200).json({ ok: true });
    }
  }
});

app.post('/logout', (req, res) => {
  // Clear the refresh token cookie
  res.clearCookie('refreshToken', {
    httpOnly: true,
    secure: false,
    domain: 'localhost',
    path: '/',
  });

  // Respond with success message
  res.status(200).json({ ok: true });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    // Find user in the database
    const user = await prisma.user.findFirst({ where: { name: username } });

    if (user) {
      // Compare passwords
      const isMatch = await bcrypt.compare(password, user.password);

      if (isMatch) {
        // Generate access token
        const accessToken = jwt.sign({ id: user.id }, tokenSecret || '', {
          expiresIn: '1h',
        });

        // Generate refresh token
        const refreshToken = jwt.sign(
          { id: user.id },
          refreshTokenSecret || '',
          {
            expiresIn: '2h',
          }
        );

        // Set refresh token as an HTTP-only cookie
        res.cookie('refreshToken', refreshToken, {
          httpOnly: true,
          secure: false,
        });

        // Send response with access token and other data
        res.status(200).json({
          ok: true,
          user,
          accessToken,
          refreshToken,
        });
      } else {
        // Password mismatch
        res.status(401).json({ ok: false, message: 'Invalid password' });
      }
    } else {
      // User not found
      res.status(401).json({ ok: false, message: 'User not found' });
    }
  } catch (error) {
    // Internal server error
    console.error('Error during login:', error);
    res.status(500).json({ ok: false, message: 'Internal server error' });
  }
});

app.post('/refreshToken', async (req, res) => {
  const refreshToken = req.cookies?.refreshToken;

  if (!refreshToken) {
    return res.status(401).json({
      ok: false,
      message: 'Error! Refresh token was not provided.',
    });
  }

  try {
    const decoded = jwt.verify(refreshToken, refreshTokenSecret || '');
    const user = await prisma.user.findUnique({
      where: { id: (decoded as any).id },
    });
    if (user) {
      const accessToken = jwt.sign({ id: user.id }, tokenSecret || '', {
        expiresIn: '1h',
      });

      return res.status(200).json({ ok: true, accessToken });
    }
    return res.status(401).json({ ok: false, message: 'User not found' });
  } catch (error) {
    return res
      .status(401)
      .json({ ok: false, message: 'Refresh token expired' });
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
  try {
    const decoded = jwt.verify(token.split(' ')[1], tokenSecret || '');
    const user = await prisma.user.findUnique({
      where: { id: (decoded as any).id },
    });
    const friends = await prisma.friend.findMany({
      where: {
        userId: (decoded as any).id,
      },
    });
    console.log({
      friendId: friends.map((friend) => friend.id),
      userId: (decoded as any).id,
    });
    const messages = await prisma.message.findFirst({
      where: {
        userId: (decoded as any).id,
        friendId: { in: friends.map((friend) => friend.id) },
      },
    });

    if (user && friends) {
      return res
        .status(200)
        .json({ ok: true, user: { ...user, friends, messages } });
    }
    return res.status(401).json({ ok: false, message: 'User not found' });
  } catch (error) {
    return res.status(401).json({ ok: false, message: 'Token expired' });
  }

  // const decodedToken =
  //   token &&
  //   jwt.verify(token.split(' ')[1], tokenSecret || '', (err, decoded) => {
  //     if (err) {
  //       return res.status(401).json({ ok: false, message: 'Token expired' });
  //     }
  //     return decoded;
  //   });

  // const user = await prisma.user.findFirst({
  //   where: {
  //     id: (decodedToken as any).id,
  //   },
  // });

  // const friends = await prisma.friend.findMany({
  //   where: {
  //     userId: (decodedToken as any).id,
  //   },
  // });

  // if (user && friends)
  //   res.status(200).json({ ok: true, user: { ...user, friends } });
  // else return res.status(401).json({ ok: false, message: 'User not found' });
});

app.post('/findUser', async (req, res) => {
  const { name } = req.body;
  const token = req.headers.authorization;

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

app.get('/friends', async (req, res) => {
  const token = req.headers.authorization;
  console.log({ token: token?.replace('Bearer ', '') });
  if (!token) {
    return res
      .status(401)
      .json({ error: 'Authorization header missing or malformed' });
  }

  try {
    const decodedToken = jwt.verify(
      token?.replace('Bearer ', ''),
      tokenSecret || ''
    );
    const userId = (decodedToken as any).id;
    // Use Prisma to find friends for the specified userId
    const friends = await prisma.friend.findMany({
      where: { userId },
    });

    if (!friends || friends.length === 0) {
      return res.status(404).json({ error: 'No friends found' });
    }

    // Return the list of friends
    return res.status(200).json({ ok: true, friends });
  } catch (error) {
    console.error('Error decoding JWT token:', error);
    return res.status(401).json({ error: 'JWT token malformed or expired' });
  }
});

app.get('/messages', async (req, res) => {
  const messages = await prisma.user.findMany({});
  res.json(messages);
});

const PORT = 8080;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
