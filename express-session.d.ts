import 'express-session';

declare module 'express-session' {
  interface SessionData {
    username?: string; // Add the username property
  }
}
