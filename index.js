const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require("express");
require("dotenv").config();
const app = express();
const cors = require("cors");
const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const port = process.env.PORT;
const { MongoClient, ServerApiVersion } = require("mongodb");
const { ObjectId } = require("mongodb");

app.use(cors());
app.use(
  "/api/payments/webhook",
  express.raw({
    type: "application/json",
  })
);
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
    const plansCollection = db.collection("plans");


    // ==========================================
// STRIPE PAYMENT WEBHOOK
// ==========================================

app.post("/api/payments/webhook", async (req, res) => {
  const signature = req.headers["stripe-signature"];

  let event;

  // ==========================================
  // VERIFY STRIPE WEBHOOK
  // ==========================================

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    console.error(
      "Stripe webhook signature error:",
      error.message
    );

    return res
      .status(400)
      .send(`Webhook Error: ${error.message}`);
  }

  try {
    // ==========================================
    // CHECKOUT COMPLETED
    // ==========================================

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const paymentType =
        session.metadata?.paymentType;

      console.log(
        `Stripe checkout completed: ${session.id}`
      );

      console.log(
        `Payment type: ${paymentType}`
      );

      // ==================================================
      // EVENT TICKET PAYMENT
      // ==================================================

      if (paymentType === "event_ticket") {
        const eventId =
          session.metadata?.eventId;

        const eventTitle =
          session.metadata?.eventTitle;

        const attendeeEmail =
          session.metadata?.attendeeEmail ||
          session.customer_details?.email ||
          session.customer_email;

        const quantity =
          Number(session.metadata?.quantity) || 1;

        const totalAmount =
          Number(session.metadata?.totalAmount) ||
          Number(session.amount_total || 0) / 100;

        // ------------------------------------------
        // Validate event booking metadata
        // ------------------------------------------

        if (
          !eventId ||
          !eventTitle ||
          !attendeeEmail
        ) {
          console.error(
            "Missing event booking metadata:",
            session.id
          );

          return res.json({
            received: true,
            bookingCreated: false,
            message:
              "Missing event booking metadata",
          });
        }

        if (!isValidId(eventId)) {
          console.error(
            "Invalid event ID:",
            eventId
          );

          return res.json({
            received: true,
            bookingCreated: false,
            message: "Invalid event ID",
          });
        }

        // ------------------------------------------
        // Prevent duplicate booking
        // ------------------------------------------

        const existingBooking =
          await bookingCollection.findOne({
            stripeSessionId: session.id,
          });

        if (existingBooking) {
          console.log(
            "Booking already processed:",
            session.id
          );

          return res.json({
            received: true,
            bookingCreated: false,
            message: "Booking already processed",
          });
        }

        // ------------------------------------------
        // Find event
        // ------------------------------------------

        const eventData =
          await eventsCollection.findOne({
            _id: new ObjectId(eventId),
          });

        if (!eventData) {
          console.error(
            "Event not found:",
            eventId
          );

          return res.json({
            received: true,
            bookingCreated: false,
            message: "Event not found",
          });
        }

        // ------------------------------------------
        // Check available seats
        // ------------------------------------------

        const availableSeats =
          Number(eventData.seats) || 0;

        if (
          availableSeats < quantity
        ) {
          console.error(
            `Not enough seats for event ${eventId}. Available: ${availableSeats}, Requested: ${quantity}`
          );

          return res.json({
            received: true,
            bookingCreated: false,
            message: "Not enough seats available",
          });
        }

        // ------------------------------------------
        // Atomically decrease seats
        // ------------------------------------------

        const seatUpdate =
          await eventsCollection.updateOne(
            {
              _id: new ObjectId(eventId),
              seats: {
                $gte: quantity,
              },
            },
            {
              $inc: {
                seats: -quantity,
              },
            }
          );

        if (
          seatUpdate.modifiedCount !== 1
        ) {
          console.error(
            "Failed to reserve event seats:",
            eventId
          );

          return res.json({
            received: true,
            bookingCreated: false,
            message:
              "Unable to reserve seats",
          });
        }

        // ------------------------------------------
        // Generate transaction ID on server
        // ------------------------------------------

        const transactionId =
          `TXN-${Date.now()}-${Math.floor(
            1000 + Math.random() * 9000
          )}`;

        // ------------------------------------------
        // Get Stripe payment intent
        // ------------------------------------------

        const stripePaymentIntentId =
          typeof session.payment_intent ===
          "string"
            ? session.payment_intent
            : session.payment_intent?.id ||
              null;

        // ------------------------------------------
        // Create booking
        // ------------------------------------------

        const bookingData = {
          eventId: String(eventId),

          eventTitle: String(
            eventTitle
          ),

          attendeeEmail:
            String(
              attendeeEmail
            ).toLowerCase(),

          quantity,

          amount: totalAmount,

          paymentStatus: "paid",

          transactionId,

          stripeSessionId:
            session.id,

          stripePaymentIntentId,

          bookingDate: new Date(),

          createdAt: new Date(),
        };

        await bookingCollection.insertOne(
          bookingData
        );

        console.log(
          "Event ticket booking created successfully:",
          {
            stripeSessionId:
              session.id,
            eventId,
            attendeeEmail,
            quantity,
            amount: totalAmount,
            transactionId,
          }
        );

        return res.json({
          received: true,
          bookingCreated: true,
          message:
            "Event ticket booking created successfully",
        });
      }

      // ==================================================
      // SUBSCRIPTION PAYMENT
      // ==================================================

      if (
        paymentType === "subscription" ||
        session.metadata?.planId
      ) {
        const planId =
          session.metadata?.planId;

        const customerEmail =
          session.customer_details?.email ||
          session.customer_email;

        const customerId =
          typeof session.customer ===
          "string"
            ? session.customer
            : session.customer?.id ||
              null;

        const subscriptionId =
          typeof session.subscription ===
          "string"
            ? session.subscription
            : session.subscription?.id ||
              null;

        // ------------------------------------------
        // Validate plan ID
        // ------------------------------------------

        if (!planId) {
          console.error(
            "Stripe checkout session has no planId metadata"
          );

          return res.json({
            received: true,
            message:
              "Missing planId metadata",
          });
        }

        // ------------------------------------------
        // Validate customer email
        // ------------------------------------------

        if (!customerEmail) {
          console.error(
            "Stripe checkout session has no customer email"
          );

          return res.json({
            received: true,
            message:
              "Missing customer email",
          });
        }

        const normalizedEmail =
          customerEmail.toLowerCase();

        // ------------------------------------------
        // Find purchased plan
        // ------------------------------------------

        const purchasedPlan =
          await plansCollection.findOne({
            planId,
            active: true,
          });

        if (!purchasedPlan) {
          console.error(
            `Plan not found: ${planId}`
          );

          return res.json({
            received: true,
            message: "Plan not found",
          });
        }

        // ------------------------------------------
        // Prevent duplicate payment records
        // ------------------------------------------

        const existingPayment =
          await paymentsCollection.findOne({
            stripeSessionId:
              session.id,
          });

        if (existingPayment) {
          console.log(
            "Payment already processed:",
            session.id
          );

          return res.json({
            received: true,
            message:
              "Payment already processed",
          });
        }

        // ------------------------------------------
        // Save payment information
        // ------------------------------------------

        const paymentData = {
          stripeSessionId:
            session.id,

          stripePaymentIntentId:
            typeof session.payment_intent ===
            "string"
              ? session.payment_intent
              : session.payment_intent?.id ||
                null,

          stripeCustomerId:
            customerId,

          stripeSubscriptionId:
            subscriptionId,

          organizerEmail:
            normalizedEmail,

          planId:
            purchasedPlan.planId,

          planName:
            purchasedPlan.name,

          amount:
            session.amount_total
              ? session.amount_total / 100
              : Number(
                  purchasedPlan.price
                ) || 0,

          currency: "USD",

          paymentStatus:
            "completed",

          paymentType:
            "subscription",

          billingPeriod:
            purchasedPlan.billingPeriod ||
            "monthly",

          maxEvents:
            purchasedPlan.maxEvents,

          unlimitedEvents:
            purchasedPlan.unlimitedEvents,

          createdAt:
            new Date(),

          updatedAt:
            new Date(),
        };

        await paymentsCollection.insertOne(
          paymentData
        );

        console.log(
          "Subscription payment saved successfully:",
          session.id
        );

        // ------------------------------------------
        // Find organizer organization
        // ------------------------------------------

        const organization =
          await organizationCollection.findOne({
            organizerEmail:
              normalizedEmail,
          });

        if (!organization) {
          console.error(
            "Organization not found for:",
            normalizedEmail
          );

          return res.json({
            received: true,
            paymentSaved: true,
            organizationUpdated: false,
          });
        }

        // ------------------------------------------
        // Update organization plan
        // ------------------------------------------

        const currentMaxEvents =
          organization.maxEvents || 0;

        const newMaxEvents =
          purchasedPlan.unlimitedEvents
            ? currentMaxEvents
            : currentMaxEvents +
              purchasedPlan.maxEvents;

        const newUnlimitedEvents =
          organization.unlimitedEvents ||
          purchasedPlan.unlimitedEvents;

        await organizationCollection.updateOne(
          {
            _id: organization._id,
          },
          {
            $set: {
              planId:
                purchasedPlan.planId,

              planName:
                purchasedPlan.name,

              maxEvents:
                newMaxEvents,

              unlimitedEvents:
                newUnlimitedEvents,

              planStatus:
                "active",

              stripeCustomerId:
                customerId,

              stripeSubscriptionId:
                subscriptionId,

              updatedAt:
                new Date(),
            },
          }
        );

        console.log(
          `Organization plan updated: ${purchasedPlan.name} (maxEvents ${currentMaxEvents} -> ${newMaxEvents})`
        );

        // ------------------------------------------
        // Update organizer user plan
        // ------------------------------------------

        await userCollection.updateOne(
          {
            email:
              normalizedEmail,
          },
          {
            $set: {
              plan:
                purchasedPlan.planId,

              updatedAt:
                new Date(),
            },
          }
        );

        console.log(
          `User plan updated: ${normalizedEmail} -> ${purchasedPlan.planId}`
        );

        return res.json({
          received: true,
          paymentSaved: true,
          organizationUpdated: true,
        });
      }

      // ==================================================
      // UNKNOWN PAYMENT TYPE
      // ==================================================

      console.warn(
        "Unknown Stripe payment type:",
        paymentType
      );

      return res.json({
        received: true,
        message:
          "Unknown payment type",
      });
    }

    // ==========================================
    // CHECKOUT EXPIRED
    // ==========================================

    if (
      event.type ===
      "checkout.session.expired"
    ) {
      const session =
        event.data.object;

      await paymentsCollection.updateOne(
        {
          stripeSessionId:
            session.id,
        },
        {
          $set: {
            paymentStatus:
              "expired",

            updatedAt:
              new Date(),
          },
        }
      );

      console.log(
        "Stripe checkout session expired:",
        session.id
      );

      return res.json({
        received: true,
      });
    }

    // ==========================================
    // SUBSCRIPTION DELETED
    // ==========================================

    if (
      event.type ===
      "customer.subscription.deleted"
    ) {
      const subscription =
        event.data.object;

      // ------------------------------------------
      // Reset organization to free plan
      // ------------------------------------------

      await organizationCollection.updateOne(
        {
          stripeSubscriptionId:
            subscription.id,
        },
        {
          $set: {
            planId: "free",

            planName: "Free",

            maxEvents: 3,

            unlimitedEvents:
              false,

            planStatus:
              "cancelled",

            stripeSubscriptionId:
              null,

            updatedAt:
              new Date(),
          },
        }
      );

      // ------------------------------------------
      // Mark subscription payments cancelled
      // ------------------------------------------

      await paymentsCollection.updateMany(
        {
          stripeSubscriptionId:
            subscription.id,

          paymentStatus:
            "completed",
        },
        {
          $set: {
            paymentStatus:
              "cancelled",

            updatedAt:
              new Date(),
          },
        }
      );

      console.log(
        "Subscription cancelled:",
        subscription.id
      );

      return res.json({
        received: true,
      });
    }

    // ==========================================
    // OTHER STRIPE EVENTS
    // ==========================================

    console.log(
      "Unhandled Stripe event:",
      event.type
    );

    return res.json({
      received: true,
    });
  } catch (error) {
    console.error(
      "Stripe webhook processing error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to process Stripe webhook",
    });
  }
});



    // ==========================================
// ORGANIZER OVERVIEW
// ==========================================

app.get(
  "/api/organizer/overview/:email",
  async (req, res) => {
    try {
      const email = decodeURIComponent(
        req.params.email
      ).toLowerCase();

      // ==========================================
      // ORGANIZATION
      // ==========================================

      const organization =
        await organizationCollection.findOne({
          organizerEmail: email,
        });

      if (!organization) {
        return res.status(404).json({
          success: false,
          message: "Organization not found",
        });
      }

      // ==========================================
      // EVENTS
      // ==========================================

      const totalEvents =
        await eventsCollection.countDocuments({
          organizationId: String(organization._id),
        });

      // ==========================================
      // BOOKINGS
      // ==========================================

      const bookingStats =
        await bookingCollection
          .aggregate([
            {
              $match: {
                eventId: {
                  $exists: true,
                },
              },
            },

            {
              $lookup: {
                from: "events",
                let: {
                  bookingEventId: "$eventId",
                },
                pipeline: [
                  {
                    $match: {
                      $expr: {
                        $or: [
                          {
                            $eq: [
                              {
                                $toString: "$_id",
                              },
                              "$$bookingEventId",
                            ],
                          },
                          {
                            $eq: [
                              "$_id",
                              "$$bookingEventId",
                            ],
                          },
                        ],
                      },
                    },
                  },
                ],
                as: "event",
              },
            },

            {
              $unwind: {
                path: "$event",
                preserveNullAndEmptyArrays: false,
              },
            },

            {
              $match: {
                "event.organizationId":
                  String(organization._id),
              },
            },

            {
              $group: {
                _id: null,

                totalAttendees: {
                  $sum: {
                    $ifNull: ["$quantity", 0],
                  },
                },

                totalRevenue: {
                  $sum: {
                    $ifNull: ["$amount", 0],
                  },
                },

                totalSoldTickets: {
                  $sum: {
                    $ifNull: ["$quantity", 0],
                  },
                },
              },
            },
          ])
          .toArray();

      const stats = bookingStats[0] || {
        totalAttendees: 0,
        totalRevenue: 0,
        totalSoldTickets: 0,
      };

      // ==========================================
      // PLAN
      // ==========================================

      let plan = await plansCollection.findOne({
        planId: organization.planId || "free",
        active: true,
      });

      // Safety fallback
      if (!plan) {
        plan = await plansCollection.findOne({
          planId: "free",
          active: true,
        });
      }

      const maxEvents =
        organization.maxEvents ??
        plan?.maxEvents ??
        3;

      const unlimitedEvents =
        organization.unlimitedEvents ??
        plan?.unlimitedEvents ??
        false;

      const eventsRemaining = unlimitedEvents
        ? null
        : Math.max(maxEvents - totalEvents, 0);

      return res.status(200).json({
        success: true,

        organization: {
          _id: organization._id,
          organizationName:
            organization.organizationName,
          organizerEmail:
            organization.organizerEmail,
        },

        plan: {
          planId: organization.planId || "free",
          planName:
            organization.planName ||
            plan?.name ||
            "Free",

          maxEvents,

          unlimitedEvents,

          planStatus:
            organization.planStatus || "active",

          price: plan?.price || 0,

          currency:
            plan?.currency || "USD",

          billingPeriod:
            plan?.billingPeriod || "monthly",
        },

        usage: {
          totalEvents,

          eventsRemaining,

          usagePercentage: unlimitedEvents
            ? 0
            : Math.min(
                Math.round(
                  (totalEvents / maxEvents) * 100
                ),
                100
              ),
        },

        stats: {
          totalEvents,

          totalAttendees:
            stats.totalAttendees || 0,

          totalRevenue:
            stats.totalRevenue || 0,

          totalSoldTickets:
            stats.totalSoldTickets || 0,
        },
      });
    } catch (error) {
      console.error(
        "Organizer overview error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to load organizer overview",
      });
    }
  }
);

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
    const {
      organizationName,
      logo,
      website,
      description,
      organizerEmail,
    } = req.body;

    if (!organizationName || !organizerEmail) {
      return res.status(400).json({
        message: "Organization name and organizer email are required",
      });
    }

    // Check existing organization
    const existingOrganization =
      await organizationCollection.findOne({
        organizerEmail,
      });

    if (existingOrganization) {
      return res.status(409).json({
        message: "Organization already exists",
        organization: existingOrganization,
      });
    }

    // Get Free plan
    const freePlan = await plansCollection.findOne({
      planId: "free",
      active: true,
    });

    if (!freePlan) {
      return res.status(500).json({
        message: "Free plan is not configured",
      });
    }

    const addData = {
      organizationName,
      logo,
      website,
      description,
      organizerEmail,

      // ==============================
      // DEFAULT FREE PLAN
      // ==============================
      planId: freePlan.planId,
      planName: freePlan.name,
      maxEvents: freePlan.maxEvents,
      unlimitedEvents: freePlan.unlimitedEvents,
      planStatus: "active",

      // Stripe
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      subscriptionCurrentPeriodEnd: null,

      status: "active",

      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result =
      await organizationCollection.insertOne(addData);

    return res.status(201).json({
      ...result,
      organization: {
        ...addData,
        _id: result.insertedId,
      },
    });
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
    const isValidId = (id) =>
      ObjectId.isValid(id) && String(new ObjectId(id)) === id;

   // ---------- CREATE EVENT ----------
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

    if (
      !title ||
      !category ||
      !location ||
      !date ||
      !banner ||
      !organizationId ||
      !organizerEmail
    ) {
      return res.status(400).json({
        message: "Missing required fields",
      });
    }

    const normalizedEmail = organizerEmail.toLowerCase().trim();

    // -----------------------------------------
    // FIND ORGANIZER
    // -----------------------------------------

    const organizer = await userCollection.findOne({
      email: normalizedEmail,
    });

    if (!organizer) {
      return res.status(404).json({
        message: "Organizer account not found",
      });
    }

    if (organizer.role !== "organizer") {
      return res.status(403).json({
        message: "Only organizers can create events",
      });
    }

    // -----------------------------------------
    // GET ORGANIZER PLAN
    // -----------------------------------------

    const currentPlanId = organizer.plan || "free";

    const plan = await plansCollection.findOne({
      planId: currentPlanId,
      active: true,
    });

    if (!plan) {
      return res.status(500).json({
        message: "Organizer plan configuration not found",
      });
    }

    // -----------------------------------------
    // COUNT ORGANIZER EVENTS
    // -----------------------------------------

    const eventCount = await eventsCollection.countDocuments({
      organizerEmail: normalizedEmail,
    });

    // -----------------------------------------
    // CHECK PLAN LIMIT
    // -----------------------------------------

    if (
      !plan.unlimitedEvents &&
      eventCount >= plan.maxEvents
    ) {
      return res.status(403).json({
        success: false,
        code: "PLAN_LIMIT_REACHED",
        message: `Your ${plan.name} plan allows up to ${plan.maxEvents} events. Please upgrade your plan to create more events.`,
        plan: {
          planId: plan.planId,
          name: plan.name,
          maxEvents: plan.maxEvents,
          unlimitedEvents: plan.unlimitedEvents,
        },
        usage: {
          used: eventCount,
          limit: plan.maxEvents,
          remaining: 0,
        },
      });
    }
    // ==========================================
// CHECK ORGANIZER PLAN LIMIT
// ==========================================

const organization =
  await organizationCollection.findOne({
    _id: new ObjectId(organizationId),
  });

if (!organization) {
  return res.status(404).json({
    success: false,
    message: "Organization not found",
  });
}

let maxEvents = organization.maxEvents || 3;

let unlimitedEvents =
  organization.unlimitedEvents || false;

let currentPlan =
  organization.planId || "free";

// Count current events
const currentEventCount =
  await eventsCollection.countDocuments({
    organizationId: String(organization._id),
  });

// Check limit
if (
  !unlimitedEvents &&
  currentEventCount >= maxEvents
) {
  return res.status(403).json({
    success: false,
    code: "PLAN_LIMIT_REACHED",

    message: `You have reached the ${maxEvents}-event limit on the ${organization.planName || currentPlan} plan.`,

    planId: currentPlan,

    maxEvents,

    currentEvents: currentEventCount,
  });
}

    // -----------------------------------------
    // CREATE EVENT
    // -----------------------------------------

    const result = await eventsCollection.insertOne({
      title,
      category,
      location,
      date,
      ticketPrice: Number(ticketPrice) || 0,
      seats: Number(seats) || 0,
      banner,
      organizerEmail: normalizedEmail,
      organizationId,

      status: "pending",

      createdAt: new Date(),
      updatedAt: new Date(),
    });

    res.status(201).json({
      success: true,
      message: "Event created successfully",
      insertedId: result.insertedId,
    });
  } catch (err) {
    console.error("Create event error:", err);

    res.status(500).json({
      success: false,
      message: "Failed to create event",
    });
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
          },
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

        const result = await eventsCollection.deleteOne({
          _id: new ObjectId(id),
        });
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
            },
          )
          .toArray();

        const categories = [
          ...new Set(
            approvedEvents.map((event) => event.category).filter(Boolean),
          ),
        ].sort();

        const locations = [
          ...new Set(
            approvedEvents.map((event) => event.location).filter(Boolean),
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

    // GET events by organizer email (Add this to your backend server file)
    app.get("/api/events/organizer/:email", async (req, res) => {
      try {
        const { email } = req.params;
        const events = await eventsCollection
          .find({ organizerEmail: email })
          .sort({ createdAt: -1 })
          .toArray();

        return res.status(200).json({ success: true, data: events });
      } catch (error) {
        console.error("Fetch organizer events error:", error);
        return res
          .status(500)
          .json({ success: false, message: "Failed to fetch events" });
      }
    });

    // ---------- ATTENDEE OVERVIEW (stats + upcoming tickets) ----------
    app.get("/api/bookings/overview/:email", async (req, res) => {
      try {
        const email = decodeURIComponent(req.params.email).toLowerCase();

        const bookings = await bookingCollection
          .aggregate([
            { $match: { attendeeEmail: email } },
            {
              $addFields: {
                eventObjectId: {
                  $cond: [
                    { $eq: [{ $strLenCP: "$eventId" }, 24] },
                    { $toObjectId: "$eventId" },
                    null,
                  ],
                },
              },
            },
            {
              $lookup: {
                from: "events",
                localField: "eventObjectId",
                foreignField: "_id",
                as: "event",
              },
            },
            { $unwind: { path: "$event", preserveNullAndEmptyArrays: true } },
            { $sort: { createdAt: -1 } },
          ])
          .toArray();

        const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

        const totalTickets = bookings.reduce(
          (sum, b) => sum + (b.quantity || 0),
          0,
        );
        const totalSpent = bookings.reduce(
          (sum, b) => sum + (b.amount || 0),
          0,
        );

        const upcoming = bookings
          .filter((b) => b.event?.date && b.event.date >= today)
          .sort((a, b) => a.event.date.localeCompare(b.event.date));

        const recentTickets = upcoming.slice(0, 5).map((b) => ({
          _id: b._id,
          bookingId: b._id,
          eventId: b.eventId,
          eventTitle: b.event?.title || b.eventTitle,
          date: b.event?.date || null,
          location: b.event?.location || "Location TBA",
          banner: b.event?.banner || "",
          ticketPrice: b.event?.ticketPrice ?? b.amount,
          quantity: b.quantity,
          amount: b.amount,
          status: b.paymentStatus,
          transactionId: b.transactionId,
        }));

        res.json({
          stats: {
            totalTickets,
            upcomingEvents: upcoming.length,
            totalSpent,
          },
          recentTickets,
        });
      } catch (err) {
        console.error("Attendee overview error:", err);
        res.status(500).json({ message: "Failed to fetch attendee overview" });
      }
    });

// ---------- GET PAYMENTS BY ORGANIZER EMAIL ----------
app.get("/api/payments/organizer/:email", async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase();

    const payments = await paymentsCollection
      .find({ organizerEmail: email })
      .sort({ createdAt: -1 })
      .toArray();

    return res.status(200).json({ success: true, data: payments });
  } catch (error) {
    console.error("Fetch organizer payments error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch payments" });
  }
});
    // ==========================================
// ADMIN DASHBOARD
// ==========================================

// ---------- ADMIN OVERVIEW STATS ----------

app.get("/api/admin/stats", async (req, res) => {
  try {
    const [
      totalUsers,
      blockedUsers,
      totalEvents,
      pendingEvents,
      approvedEvents,
      rejectedEvents,
      totalBookings,
      revenueResult,
    ] = await Promise.all([
      userCollection.countDocuments({}),

      userCollection.countDocuments({
        isBlocked: true,
      }),

      eventsCollection.countDocuments({}),

      eventsCollection.countDocuments({
        status: "pending",
      }),

      eventsCollection.countDocuments({
        status: "approved",
      }),

      eventsCollection.countDocuments({
        status: "rejected",
      }),

      bookingCollection.countDocuments({}),

      bookingCollection
        .aggregate([
          {
            $group: {
              _id: null,
              totalRevenue: {
                $sum: {
                  $convert: {
                    input: "$amount",
                    to: "double",
                    onError: 0,
                    onNull: 0,
                  },
                },
              },
            },
          },
        ])
        .toArray(),
    ]);

    const totalRevenue = revenueResult[0]?.totalRevenue || 0;

    res.json({
      totalUsers,
      blockedUsers,
      activeUsers: totalUsers - blockedUsers,

      totalEvents,
      pendingEvents,
      approvedEvents,
      rejectedEvents,

      totalBookings,
      totalRevenue,
    });
  } catch (error) {
    console.error("Admin stats error:", error);

    res.status(500).json({
      message: "Failed to fetch admin stats",
    });
  }
});

// ==========================================
// ADMIN USERS
// ==========================================

app.get("/api/admin/users", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);

    const limit = Math.min(
      Math.max(parseInt(req.query.limit) || 10, 1),
      50
    );

    const search = req.query.search?.trim() || "";
    const status = req.query.status || "";

    const query = {};

    if (search) {
      const escapedSearch = search.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

      query.$or = [
        {
          name: {
            $regex: escapedSearch,
            $options: "i",
          },
        },
        {
          email: {
            $regex: escapedSearch,
            $options: "i",
          },
        },
      ];
    }

    if (status === "blocked") {
      query.isBlocked = true;
    }

    if (status === "active") {
      query.$or = [
        ...(query.$or || []),
        {
          isBlocked: {
            $ne: true,
          },
        },
      ];
    }

    const [users, total] = await Promise.all([
      userCollection
        .find(query)
        .project({
          name: 1,
          email: 1,
          image: 1,
          role: 1,
          isBlocked: 1,
          createdAt: 1,
        })
        .sort({
          createdAt: -1,
        })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),

      userCollection.countDocuments(query),
    ]);

    res.json({
      users,
      total,
      page,
      totalPages: Math.max(Math.ceil(total / limit), 1),
    });
  } catch (error) {
    console.error("Admin users error:", error);

    res.status(500).json({
      message: "Failed to fetch users",
    });
  }
});

app.patch("/api/admin/users/:id/block", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return res.status(400).json({
        message: "Invalid user id",
      });
    }

    const result = await userCollection.updateOne(
      {
        _id: new ObjectId(id),
      },
      {
        $set: {
          isBlocked: true,
          updatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    res.json({
      success: true,
      message: "User blocked successfully",
    });
  } catch (error) {
    console.error("Block user error:", error);

    res.status(500).json({
      message: "Failed to block user",
    });
  }
});

app.patch("/api/admin/users/:id/unblock", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return res.status(400).json({
        message: "Invalid user id",
      });
    }

    const result = await userCollection.updateOne(
      {
        _id: new ObjectId(id),
      },
      {
        $set: {
          isBlocked: false,
          updatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    res.json({
      success: true,
      message: "User unblocked successfully",
    });
  } catch (error) {
    console.error("Unblock user error:", error);

    res.status(500).json({
      message: "Failed to unblock user",
    });
  }
});

// ==========================================
// ADMIN EVENTS
// ==========================================

app.get("/api/admin/events", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);

    const limit = Math.min(
      Math.max(parseInt(req.query.limit) || 10, 1),
      50
    );

    const search = req.query.search?.trim() || "";
    const status = req.query.status || "";

    const query = {};

    if (search) {
      const escapedSearch = search.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

      query.$or = [
        {
          title: {
            $regex: escapedSearch,
            $options: "i",
          },
        },
        {
          category: {
            $regex: escapedSearch,
            $options: "i",
          },
        },
        {
          location: {
            $regex: escapedSearch,
            $options: "i",
          },
        },
        {
          organizerEmail: {
            $regex: escapedSearch,
            $options: "i",
          },
        },
      ];
    }

    if (status) {
      query.status = status;
    }

    const [events, total] = await Promise.all([
      eventsCollection
        .find(query)
        .sort({
          createdAt: -1,
        })
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
  } catch (error) {
    console.error("Admin events error:", error);

    res.status(500).json({
      message: "Failed to fetch admin events",
    });
  }
});

app.patch("/api/admin/events/:id/approve", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return res.status(400).json({
        message: "Invalid event id",
      });
    }

    const result = await eventsCollection.updateOne(
      {
        _id: new ObjectId(id),
      },
      {
        $set: {
          status: "approved",
          moderatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        message: "Event not found",
      });
    }

    res.json({
      success: true,
      message: "Event approved successfully",
    });
  } catch (error) {
    console.error("Approve event error:", error);

    res.status(500).json({
      message: "Failed to approve event",
    });
  }
});

app.patch("/api/admin/events/:id/reject", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return res.status(400).json({
        message: "Invalid event id",
      });
    }

    const result = await eventsCollection.updateOne(
      {
        _id: new ObjectId(id),
      },
      {
        $set: {
          status: "rejected",
          moderatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        message: "Event not found",
      });
    }

    res.json({
      success: true,
      message: "Event rejected successfully",
    });
  } catch (error) {
    console.error("Reject event error:", error);

    res.status(500).json({
      message: "Failed to reject event",
    });
  }
});

app.delete("/api/admin/events/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return res.status(400).json({
        message: "Invalid event id",
      });
    }

    const result = await eventsCollection.deleteOne({
      _id: new ObjectId(id),
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        message: "Event not found",
      });
    }

    res.json({
      success: true,
      message: "Event deleted successfully",
    });
  } catch (error) {
    console.error("Admin delete event error:", error);

    res.status(500).json({
      message: "Failed to delete event",
    });
  }
});

// ==========================================
// ADMIN TRANSACTIONS
// ==========================================

app.get("/api/admin/transactions", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);

    const limit = Math.min(
      Math.max(parseInt(req.query.limit) || 10, 1),
      50
    );

    const search = req.query.search?.trim() || "";
    const status = req.query.status || "";

    const query = {};

    if (search) {
      const escapedSearch = search.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

      query.$or = [
        {
          transactionId: {
            $regex: escapedSearch,
            $options: "i",
          },
        },
        {
          attendeeEmail: {
            $regex: escapedSearch,
            $options: "i",
          },
        },
        {
          eventTitle: {
            $regex: escapedSearch,
            $options: "i",
          },
        },
      ];
    }

    if (status) {
      query.paymentStatus = status;
    }

    const [transactions, total, revenueResult] =
      await Promise.all([
        bookingCollection
          .find(query)
          .sort({
            createdAt: -1,
          })
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray(),

        bookingCollection.countDocuments(query),

        bookingCollection
          .aggregate([
            {
              $match: query,
            },
            {
              $group: {
                _id: null,
                totalRevenue: {
                  $sum: {
                    $convert: {
                      input: "$amount",
                      to: "double",
                      onError: 0,
                      onNull: 0,
                    },
                  },
                },
              },
            },
          ])
          .toArray(),
      ]);

    res.json({
      transactions,
      total,
      page,
      totalPages: Math.max(Math.ceil(total / limit), 1),
      totalRevenue: revenueResult[0]?.totalRevenue || 0,
    });
  } catch (error) {
    console.error("Admin transactions error:", error);

    res.status(500).json({
      message: "Failed to fetch transactions",
    });
  }
});

// ==========================================
// ADMIN ANALYTICS
// ==========================================

app.get("/api/admin/analytics", async (req, res) => {
  try {
    const [
      monthlyUsers,
      monthlyBookings,
      categoryStats,
      eventStatusStats,
      revenueStats,
    ] = await Promise.all([
      // Users by month
      userCollection
        .aggregate([
          {
            $match: {
              createdAt: {
                $exists: true,
              },
            },
          },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m",
                  date: "$createdAt",
                },
              },
              users: {
                $sum: 1,
              },
            },
          },
          {
            $sort: {
              _id: 1,
            },
          },
        ])
        .toArray(),

      // Bookings by month
      bookingCollection
        .aggregate([
          {
            $match: {
              createdAt: {
                $exists: true,
              },
            },
          },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m",
                  date: "$createdAt",
                },
              },
              bookings: {
                $sum: 1,
              },
            },
          },
          {
            $sort: {
              _id: 1,
            },
          },
        ])
        .toArray(),

      // Events by category
      eventsCollection
        .aggregate([
          {
            $group: {
              _id: "$category",
              count: {
                $sum: 1,
              },
            },
          },
          {
            $sort: {
              count: -1,
            },
          },
        ])
        .toArray(),

      // Event status
      eventsCollection
        .aggregate([
          {
            $group: {
              _id: "$status",
              count: {
                $sum: 1,
              },
            },
          },
        ])
        .toArray(),

      // Revenue by month
      bookingCollection
        .aggregate([
          {
            $match: {
              createdAt: {
                $exists: true,
              },
            },
          },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m",
                  date: "$createdAt",
                },
              },
              revenue: {
                $sum: {
                  $convert: {
                    input: "$amount",
                    to: "double",
                    onError: 0,
                    onNull: 0,
                  },
                },
              },
            },
          },
          {
            $sort: {
              _id: 1,
            },
          },
        ])
        .toArray(),
    ]);

    res.json({
      monthlyUsers,
      monthlyBookings,
      categoryStats,
      eventStatusStats,
      revenueStats,
    });
  } catch (error) {
    console.error("Admin analytics error:", error);

    res.status(500).json({
      message: "Failed to fetch analytics",
    });
  }
});

app.get("/api/plans", async (req, res) => {
  try {
    const plans = await plansCollection
      .find({ active: true })
      .sort({ price: 1 })
      .toArray();

    res.status(200).json(plans);
  } catch (error) {
    console.error("Get plans error:", error);

    res.status(500).json({
      message: "Failed to fetch plans",
    });
  }
});






    // ==========================================
    // BOOKING APIs
    // ==========================================
app.get("/api/payments/checkout-session/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: "Stripe session ID is required.",
      });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["line_items", "payment_intent"],
    });

    return res.status(200).json({
      success: true,
      session,
    });
  } catch (error) {
    console.error("Get Stripe checkout session error:", error);

    return res.status(500).json({
      success: false,
      message:
        error?.message || "Failed to retrieve Stripe checkout session.",
    });
  }
});


    // ---------- CREATE BOOKING ----------
 app.post("/api/bookings", async (req, res) => {
  try {
    const {
      eventId,
      eventTitle,
      attendeeEmail,
      quantity,
      amount,
      paymentStatus,
      transactionId,
      bookingDate,
    } = req.body;

    if (!eventId || !eventTitle || !attendeeEmail) {
      return res.status(400).json({
        success: false,
        message:
          "Missing required booking details (eventId, eventTitle, attendeeEmail)",
      });
    }

    const requestedQuantity = Number(quantity) || 1;
    const bookingAmount = Number(amount) || 0;

    const finalTxnId =
      transactionId ||
      `TXN-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

    // Check event and available seats
    if (isValidId(eventId)) {
      const event = await eventsCollection.findOne({
        _id: new ObjectId(eventId),
      });

      if (!event) {
        return res.status(404).json({
          success: false,
          message: "Event not found",
        });
      }

      if (event.seats < requestedQuantity) {
        return res.status(400).json({
          success: false,
          message: "Not enough seats available for this event",
        });
      }

      // Reduce available seats
      await eventsCollection.updateOne(
        { _id: new ObjectId(eventId) },
        {
          $inc: {
            seats: -requestedQuantity,
          },
        },
      );
    }

    const newBooking = {
      eventId: String(eventId),
      eventTitle: String(eventTitle),
      attendeeEmail: attendeeEmail.toLowerCase(),
      quantity: requestedQuantity,
      amount: bookingAmount,
      paymentStatus: paymentStatus || "paid",
      transactionId: finalTxnId,
      bookingDate: bookingDate
        ? new Date(bookingDate)
        : new Date(),
      createdAt: new Date(),
    };

    const result = await bookingCollection.insertOne(newBooking);

    return res.status(201).json({
      success: true,
      message: "Booking created successfully",
      insertedId: result.insertedId,
      booking: newBooking,
    });
  } catch (error) {
    console.error("Create booking error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create booking",
    });
  }
});
    // ---------- GET BOOKINGS BY ATTENDEE EMAIL ----------
    app.get("/api/bookings/user/:email", async (req, res) => {
      try {
        const email = decodeURIComponent(req.params.email).toLowerCase();

        const userBookings = await bookingCollection
          .find({ attendeeEmail: email })
          .sort({ createdAt: -1 })
          .toArray();

        return res.status(200).json(userBookings);
      } catch (error) {
        console.error("Fetch user bookings error:", error);
        return res.status(500).json({ message: "Failed to fetch bookings" });
      }
    });

    // ---------- GET ALL BOOKINGS FOR AN ORGANIZER'S EVENTS ----------
    app.get("/api/bookings/organizer/:email", async (req, res) => {
      try {
        const email = decodeURIComponent(req.params.email).toLowerCase();

        const organizerEvents = await eventsCollection
          .find({ organizerEmail: email }, { projection: { _id: 1 } })
          .toArray();

        const eventIds = organizerEvents.map((e) => e._id.toString());

        if (eventIds.length === 0) {
          return res.status(200).json([]);
        }

        const bookings = await bookingCollection
          .find({ eventId: { $in: eventIds } })
          .sort({ createdAt: -1 })
          .toArray();

        return res.status(200).json(bookings);
      } catch (error) {
        console.error("Fetch organizer bookings error:", error);
        return res
          .status(500)
          .json({ message: "Failed to fetch organizer bookings" });
      }
    });

    // ---------- UPDATE BOOKING QUANTITY ----------
    app.patch("/api/bookings/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const { newQuantity } = req.body;

        if (!isValidId(id)) {
          return res.status(400).json({ message: "Invalid booking ID" });
        }

        const qty = Number(newQuantity);
        if (!qty || qty < 1) {
          return res
            .status(400)
            .json({ message: "Quantity must be at least 1" });
        }

        const existingBooking = await bookingCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!existingBooking) {
          return res.status(404).json({ message: "Booking not found" });
        }

        const diff = qty - existingBooking.quantity;

        // Check available seats if increasing quantity
        if (diff > 0 && isValidId(existingBooking.eventId)) {
          const event = await eventsCollection.findOne({
            _id: new ObjectId(existingBooking.eventId),
          });

          if (!event || event.seats < diff) {
            return res.status(400).json({
              message: `Not enough seats available. Only ${event?.seats || 0} left.`,
            });
          }

          // Decrement event seats by difference
          await eventsCollection.updateOne(
            { _id: new ObjectId(existingBooking.eventId) },
            { $inc: { seats: -diff } },
          );
        } else if (diff < 0 && isValidId(existingBooking.eventId)) {
          // Restore event seats if reducing quantity
          await eventsCollection.updateOne(
            { _id: new ObjectId(existingBooking.eventId) },
            { $inc: { seats: Math.abs(diff) } },
          );
        }

        // Recalculate amount based on price per ticket
        const unitPrice =
          existingBooking.amount / (existingBooking.quantity || 1);
        const updatedAmount = unitPrice * qty;

        const result = await bookingCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              quantity: qty,
              amount: updatedAmount,
              updatedAt: new Date(),
            },
          },
        );

        return res.status(200).json({
          success: true,
          message: "Booking updated successfully",
          result,
        });
      } catch (error) {
        console.error("Update booking error:", error);
        return res.status(500).json({ message: "Failed to update booking" });
      }
    });

    // ---------- CANCEL BOOKING ----------
    app.delete("/api/bookings/:id", async (req, res) => {
      try {
        const { id } = req.params;

        if (!isValidId(id)) {
          return res.status(400).json({ message: "Invalid booking ID" });
        }

        const booking = await bookingCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!booking) {
          return res.status(404).json({ message: "Booking not found" });
        }

        // Restore seats back to the event
        if (isValidId(booking.eventId)) {
          await eventsCollection.updateOne(
            { _id: new ObjectId(booking.eventId) },
            { $inc: { seats: Number(booking.quantity) || 1 } },
          );
        }

        // Delete booking from database
        await bookingCollection.deleteOne({ _id: new ObjectId(id) });

        return res
          .status(200)
          .json({ success: true, message: "Booking cancelled successfully" });
      } catch (error) {
        console.error("Cancel booking error:", error);
        return res.status(500).json({ message: "Failed to cancel booking" });
      }
    });

    // ---------- UPDATE USER PROFILE ----------
app.patch("/api/users/profile", async (req, res) => {
  try {
    const { email, name, image } = req.body;

    // Validate email
    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    // Validate name
    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Name is required",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Find user
    const existingUser = await userCollection.findOne({
      email: normalizedEmail,
    });

    if (!existingUser) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Update ONLY name and image
    const updateData = {
      name: name.trim(),
      image: image || "",
      updatedAt: new Date(),
    };

    const result = await userCollection.updateOne(
      {
        email: normalizedEmail,
      },
      {
        $set: updateData,
      }
    );

    if (result.modifiedCount === 0) {
      return res.status(200).json({
        success: true,
        message: "Profile information is already up to date",
      });
    }

    // Get updated user
    const updatedUser = await userCollection.findOne(
      {
        email: normalizedEmail,
      },
      {
        projection: {
          password: 0,
        },
      }
    );

    return res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      user: updatedUser,
    });
  } catch (error) {
    console.error("Update profile error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update profile",
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
