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
