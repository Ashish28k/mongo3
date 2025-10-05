const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/ticket_booking_db';
const PORT = process.env.PORT || 4000;
const LOCK_CLEANUP_INTERVAL_MS = 10 * 1000;

mongoose.set('strictQuery', false);

const seatSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
  seatNumber: { type: String, required: true },
  status: { type: String, enum: ['available','locked','booked'], default: 'available', index: true },
  lockOwner: { type: String, default: null },
  lockExpiresAt: { type: Date, default: null },
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null }
}, { timestamps: true });

seatSchema.index({ eventId: 1, seatNumber: 1 }, { unique: true });

const bookingSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
  ownerId: { type: String, required: true },
  seats: [{ seatNumber: String }],
  createdAt: { type: Date, default: Date.now }
});

const eventSchema = new mongoose.Schema({
  name: { type: String, required: true },
  metadata: { type: Object, default: {} }
}, { timestamps: true });

const Seat = mongoose.model('Seat', seatSchema);
const Booking = mongoose.model('Booking', bookingSchema);
const Event = mongoose.model('Event', eventSchema);

const app = express();
app.use(bodyParser.json());

async function connectDb() {
  await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log('MongoDB connected');
}

app.post('/events', async (req, res) => {
  try {
    const { name, seatNumbers = [], metadata = {} } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const event = await Event.create({ name, metadata });
    const seats = seatNumbers.map(sn => ({ eventId: event._id, seatNumber: sn }));
    if (seats.length) await Seat.insertMany(seats);
    return res.status(201).json({ event });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/events/:eventId/seats', async (req, res) => {
  try {
    const { eventId } = req.params;
    const seats = await Seat.find({ eventId }).sort({ seatNumber: 1 }).lean();
    return res.json({ seats });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/events/:eventId/lock', async (req, res) => {
  try {
    const { eventId } = req.params;
    const { seatNumbers, ownerId, ttlSeconds = 60 } = req.body;
    if (!Array.isArray(seatNumbers) || seatNumbers.length === 0) return res.status(400).json({ error: 'seatNumbers required' });
    if (!ownerId) return res.status(400).json({ error: 'ownerId required' });

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const lockedSeats = [];
      for (const seatNumber of seatNumbers) {
        const filter = {
          eventId,
          seatNumber,
          $or: [
            { status: 'available' },
            { status: 'locked', lockExpiresAt: { $lte: now } }
          ]
        };
        const update = {
          $set: { status: 'locked', lockOwner: ownerId, lockExpiresAt: expiresAt, bookingId: null }
        };
        const seat = await Seat.findOneAndUpdate(filter, update, { new: true, session });
        if (!seat) {
          await session.abortTransaction();
          session.endSession();
          return res.status(409).json({ error: `Seat ${seatNumber} unavailable` });
        }
        lockedSeats.push(seat);
      }
      await session.commitTransaction();
      session.endSession();
      return res.status(200).json({ lockedSeats });
    } catch (err) {
      await session.abortTransaction();
      session.endSession();
      return res.status(500).json({ error: err.message });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/events/:eventId/confirm', async (req, res) => {
  try {
    const { eventId } = req.params;
    const { seatNumbers, ownerId } = req.body;
    if (!Array.isArray(seatNumbers) || seatNumbers.length === 0) return res.status(400).json({ error: 'seatNumbers required' });
    if (!ownerId) return res.status(400).json({ error: 'ownerId required' });

    const now = new Date();

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const seatsToBook = [];
      for (const seatNumber of seatNumbers) {
        const filter = {
          eventId,
          seatNumber,
          status: 'locked',
          lockOwner: ownerId,
          lockExpiresAt: { $gt: now }
        };
        const seat = await Seat.findOne(filter).session(session);
        if (!seat) {
          await session.abortTransaction();
          session.endSession();
          return res.status(409).json({ error: `Seat ${seatNumber} is not locked by you or lock expired` });
        }
        seatsToBook.push(seat);
      }

      const booking = await Booking.create([{ eventId, ownerId, seats: seatNumbers.map(s => ({ seatNumber: s })) }], { session });
      const bookingId = booking[0]._id;

      for (const seatNumber of seatNumbers) {
        await Seat.updateOne(
          { eventId, seatNumber },
          { $set: { status: 'booked', bookingId, lockOwner: null, lockExpiresAt: null } },
          { session }
        );
      }

      await session.commitTransaction();
      session.endSession();

      return res.status(201).json({ booking: booking[0] });
    } catch (err) {
      await session.abortTransaction();
      session.endSession();
      return res.status(500).json({ error: err.message });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/events/:eventId/cancel', async (req, res) => {
  try {
    const { eventId } = req.params;
    const { seatNumbers, ownerId } = req.body;
    if (!Array.isArray(seatNumbers) || seatNumbers.length === 0) return res.status(400).json({ error: 'seatNumbers required' });
    if (!ownerId) return res.status(400).json({ error: 'ownerId required' });

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      for (const seatNumber of seatNumbers) {
        const seat = await Seat.findOne({ eventId, seatNumber }).session(session);
        if (!seat) {
          await session.abortTransaction();
          session.endSession();
          return res.status(404).json({ error: `Seat ${seatNumber} not found` });
        }
        if (seat.status === 'booked') {
          await session.abortTransaction();
          session.endSession();
          return res.status(409).json({ error: `Seat ${seatNumber} already booked and cannot be cancelled via this endpoint` });
        }
        if (seat.status === 'locked' && seat.lockOwner === ownerId) {
          await Seat.updateOne({ eventId, seatNumber }, { $set: { status: 'available', lockOwner: null, lockExpiresAt: null } }, { session });
        } else {
          await session.abortTransaction();
          session.endSession();
          return res.status(409).json({ error: `Seat ${seatNumber} not locked by you` });
        }
      }
      await session.commitTransaction();
      session.endSession();
      return res.json({ cancelled: seatNumbers });
    } catch (err) {
      await session.abortTransaction();
      session.endSession();
      return res.status(500).json({ error: err.message });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/bookings/:ownerId', async (req, res) => {
  try {
    const bookings = await Booking.find({ ownerId }).lean();
    return res.json({ bookings });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

async function cleanupExpiredLocks() {
  try {
    const now = new Date();
    const result = await Seat.updateMany(
      { status: 'locked', lockExpiresAt: { $lte: now } },
      { $set: { status: 'available', lockOwner: null, lockExpiresAt: null } }
    ).exec();
    if (result.modifiedCount > 0) {
      console.log(`cleanupExpiredLocks: released ${result.modifiedCount} seats`);
    }
  } catch (err) {
    console.error('cleanupExpiredLocks error:', err.message);
  }
}

app.get('/', (req, res) => res.send('Ticket Booking System'));

app.listen(PORT, async () => {
  await connectDb();
  setInterval(cleanupExpiredLocks, LOCK_CLEANUP_INTERVAL_MS);
  console.log(`Server listening on port ${PORT}`);
});
