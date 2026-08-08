/**
 * Game-server Mongoose connection.
 *
 * The game-server runs in its own Node process and cannot import
 * `app/utils/dbConnection.server.ts` (boundary rule). It manages its
 * own connection here, reading `MONGODB_URI` from the environment.
 *
 * The shared `MatchModel` from `~/db/models/Match` is then used as-is.
 */
import mongoose from "mongoose";

let connectPromise: Promise<typeof mongoose> | null = null;

export function connectGameDb(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) {
    return Promise.resolve(mongoose);
  }
  if (connectPromise) {
    return connectPromise;
  }
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("game-server: MONGODB_URI is not set");
  }
  connectPromise = mongoose.connect(uri, { bufferCommands: false });
  return connectPromise;
}
