const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require("express");
require("dotenv").config();
const app = express();
const cors = require("cors");
const port = process.env.PORT;
const { MongoClient, ServerApiVersion } = require("mongodb");
const { ObjectId } = require("mongodb");

app.use(cors());
app.use(express.json());

const uri = process.env.MONGODB_URI;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db(process.env.DB_NAME);
    const userCollection = db.collection("user");
    const organizationCollection = db.collection("organizations");
    const eventsCollection = db.collection("events");
    const bookingCollection = db.collection("bookings");
    const paymentsCollection = db.collection("payments");

    // Getting Organization Info 
    app.get("/api/organization/:email", async (req, res) => {
      try {
        const { email } = req.params;

        const result = await organizationCollection.findOne({
          organizerEmail: email,
        });

        return res.status(200).json(result || null);
      } catch (error) {
        console.error("Get organization error:", error);

        return res.status(500).json({
          message: "Failed to get organization",
        });
      }
    });

    // Post Organization in DB
    app.post("/api/organization", async (req, res) => {
      try {
        const { organizationName, logo, website, description, organizerEmail } =
          req.body;

        // Check existing organization
        const existingOrganization = await organizationCollection.findOne({
          organizerEmail,
        });

        if (existingOrganization) {
          return res.status(409).json({
            message: "Organization already exists",
            organization: existingOrganization,
          });
        }

        const addData = {
          organizationName,
          logo,
          website,
          description,
          organizerEmail,
          createdAt: new Date(),
          updatedAt: new Date(),
          status: "active",
        };

        const result = await organizationCollection.insertOne(addData);

        return res.status(201).json(result);
      } catch (error) {
        console.error("Create organization error:", error);

        return res.status(500).json({
          message: "Failed to create organization",
        });
      }
    });

    // Updated organization info
    app.patch("/api/organization/:id", async (req, res) => {
      try {
        const { id } = req.params;

        const { organizationName, logo, website, description, organizerEmail } =
          req.body;

        const updateData = {
          organizationName,
          logo,
          website,
          description,
          organizerEmail,
          status: "active",
          updatedAt: new Date(),
        };

        const result = await organizationCollection.updateOne(
          {
            _id: new ObjectId(id),
          },
          {
            $set: updateData,
          },
        );

        return res.status(200).json(result);
      } catch (error) {
        console.error("Update organization error:", error);

        return res.status(500).json({
          message: "Failed to update organization",
        });
      }
    });

    // add-Event
    app.get("/api/events/organization/:organizationId", async (req, res) => {
  try {
    const events = await eventsCollection
      .find({ organizationId: req.params.organizationId })
      .sort({ _id: -1 })
      .toArray();
    res.json(events);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch events" });
  }
});

// helper: validate ObjectId so bad ids return 400 instead of crashing
const isValidId = (id) => ObjectId.isValid(id) && String(new ObjectId(id)) === id;




// ---------- CREATE ----------
app.post("/api/events", async (req, res) => {
  try {
    const {
      title,
      category,
      location,
      date,
      ticketPrice,
      seats,
      banner,
      organizerEmail,
      organizationId,
    } = req.body;

    if (!title || !category || !location || !date || !banner || !organizationId) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const result = await eventsCollection.insertOne({
      title,
      category,
      location,
      date,
      ticketPrice: Number(ticketPrice),
      seats: Number(seats),
      banner,
      organizerEmail,
      organizationId,
      status: "pending", // always forced by the server
      createdAt: new Date(),
    });

    res.status(201).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to create event" });
  }
});

// ---------- UPDATE ----------
app.patch("/api/events/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ message: "Invalid event id" });
    }

    const { title, category, location, date, ticketPrice, seats, banner } =
      req.body;

    const result = await eventsCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          title,
          category,
          location,
          date,
          ticketPrice: Number(ticketPrice),
          seats: Number(seats),
          banner,
          status: "pending", // edits go back for approval
          updatedAt: new Date(),
        },
      }
    );

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update event" });
  }
});

// ---------- DELETE ----------
app.delete("/api/events/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ message: "Invalid event id" });
    }

    const result = await eventsCollection.deleteOne({ _id: new ObjectId(id) });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete event" });
  }
});

// escape user input so it can't break the regex
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Only approved events are public.
// While testing, you can temporarily set this to {} to see pending events.
const PUBLIC_FILTER = { status: "approved" };

// ==========================================
// GET SINGLE EVENT
// Only approved events are publicly visible
// ==========================================

app.get("/api/events/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return res.status(400).json({
        message: "Invalid event id",
      });
    }

    const event = await eventsCollection.findOne({
      _id: new ObjectId(id),
      status: "approved",
    });

    if (!event) {
      return res.status(404).json({
        message: "Event not found",
      });
    }

    res.json(event);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      message: "Failed to fetch event",
    });
  }
});

// ---------- BROWSE (search + filter + pagination) ----------
app.get("/api/events", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 8, 1), 24);
    const { search, category, location } = req.query;

    const query = { ...PUBLIC_FILTER };
    if (search?.trim()) {
      query.title = { $regex: escapeRegex(search.trim()), $options: "i" };
    }
    if (category) query.category = category;
    if (location) query.location = location;

    const [events, total] = await Promise.all([
      eventsCollection
        .find(query)
        .sort({ date: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      eventsCollection.countDocuments(query),
    ]);

    res.json({
      events,
      total,
      page,
      totalPages: Math.max(Math.ceil(total / limit), 1),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch events" });
  }
});

app.get("/api/events-filters", async (req, res) => {
  try {
    const approvedEvents = await eventsCollection
      .find(
        { status: "approved" },
        {
          projection: {
            category: 1,
            location: 1,
          },
        }
      )
      .toArray();

    const categories = [
      ...new Set(
        approvedEvents
          .map((event) => event.category)
          .filter(Boolean)
      ),
    ].sort();

    const locations = [
      ...new Set(
        approvedEvents
          .map((event) => event.location)
          .filter(Boolean)
      ),
    ].sort();

    res.status(200).json({
      categories,
      locations,
    });
  } catch (error) {
    console.error("EVENT FILTER ERROR:", error);

    res.status(500).json({
      message: "Failed to fetch filters",
      error: error.message,
    });
  }
});



    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
