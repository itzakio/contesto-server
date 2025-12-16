const express = require("express");
const cors = require("cors");
require("dotenv").config();
const app = express();
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const admin = require("firebase-admin");

const serviceAccount = require("./contesto-firebase-adminsdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// middleware
app.use(express.json());
app.use(cors());

const verifyFBToken = async (req, res, next) => {
  const authorization = req.headers.authorization;
  if (!authorization) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  const token = authorization.split(" ")[1];
  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = {
      email: decoded.email,
      uid: decoded.uid,
    };
    next();
  } catch (error) {
    return res.status(401).send({ message: "unauthorized access" });
  }
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.k11w7kv.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

app.get("/", (req, res) => {
  res.send("Contesto!");
});

const run = async () => {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const database = client.db("contesto_db");
    const usersCollection = database.collection("users");
    const creatorsCollection = database.collection("creators");
    const contestsCollection = database.collection("contests");
    const paymentsCollection = database.collection("payments");
    const participantsCollection = database.collection("participants");

    // middleware with database access
    // verify admin before admin activity
    // must use verifyFBToken before use verifyAdmin
    const verifyAdmin = async (req, res, next) => {
      const email = req.user.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    const verifyCreator = async (req, res, next) => {
      const email = req.user.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "creator") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    // users related apis
    app.get("/users", verifyFBToken, verifyAdmin, async (req, res) => {
      const searchText = req.query.searchText;
      const query = {};
      if (searchText) {
        query.$or = [
          { name: { $regex: searchText, $options: "i" } },
          { email: { $regex: searchText, $options: "i" } },
        ];
      }
      const result = await usersCollection.find(query).toArray();
      res.send(result);
    });

    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createdAt = new Date().toISOString();
      const email = user.email;
      const userExist = await usersCollection.findOne({ email });
      if (userExist) {
        return res.send({ message: "user already exist" });
      }
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    app.patch(
      "/users/:id/role",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const roleInfo = req.body;
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const updatedDoc = {
          $set: {
            role: roleInfo.role,
          },
        };
        const result = await usersCollection.updateOne(query, updatedDoc);
        res.send(result);
      }
    );

    // creator related apis
    app.get("/creators", async (req, res) => {
      const { searchText, email } = req.query;
      const query = {};
      if (searchText) {
        query.$or = [
          { name: { $regex: searchText, $options: "i" } },
          { email: { $regex: searchText, $options: "i" } },
        ];
      }
      if (email) {
        query.email = email;
      }
      const result = await creatorsCollection.find(query).toArray();
      res.send(result);
    });

    app.post("/creators", async (req, res) => {
      const creatorInfo = req.body;
      creatorInfo.status = "pending";
      creatorInfo.createdAt = new Date().toISOString();
      const creatorExist = await creatorsCollection.findOne({
        email: creatorInfo.email,
      });
      if (creatorExist) {
        return res.send({ message: "Creator already exist!" });
      }
      const isAdmin = await usersCollection.findOne({
        email: creatorInfo.email,
      });
      if (isAdmin.role === "admin") {
        return res.send({ message: "Admin can't apply to be a creator!" });
      }
      const result = await creatorsCollection.insertOne(creatorInfo);
      res.send(result);
    });

    app.patch("/creators/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const { status, email } = req.body;
      const query = { _id: new ObjectId(id) };
      const userQuery = { email: email };
      const userRole = {};
      if (status === "approved") {
        userRole.role = "creator";
      } else {
        userRole.role = "user";
      }
      const roleUpdate = {
        $set: { role: userRole.role },
      };
      const userResult = await usersCollection.updateOne(userQuery, roleUpdate);
      const updatedDoc = {
        $set: {
          status: status,
        },
      };
      const result = await creatorsCollection.updateOne(query, updatedDoc);
      res.send(result);
    });

    app.delete(
      "/creators/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await creatorsCollection.deleteOne(query);
        res.send(result);
      }
    );

    // contest related apis
    app.get("/contests", async (req, res) => {
      const query = { status: "approved" };
      const result = await contestsCollection
        .find(query)
        .sort({ participationEndAt: -1 })
        .toArray();
      res.send(result);
    });

    app.get("/contests/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await contestsCollection.findOne(query);
      res.send(result);
    });

    app.get(
      "/creator/contests",
      verifyFBToken,
      verifyCreator,
      async (req, res) => {
        const { email } = req.query;
        const query = email ? { creatorEmail: email } : {};
        const result = await contestsCollection.find(query).toArray();
        res.send(result);
      }
    );

    app.get("/admin/contests", verifyFBToken, verifyAdmin, async (req, res) => {
      const { status } = req.query;
      const query = status ? { status } : {};
      const result = await contestsCollection.find(query).toArray();
      res.send(result);
    });

    app.get("/my-joined-contests", verifyFBToken, async (req, res) => {
      try {
        const userEmail = req.user.email;

        const pipeline = [
          {
            $match: { userEmail },
          },
          {
            $lookup: {
              from: "contests",
              localField: "contestId", // ObjectId
              foreignField: "_id", // ObjectId
              as: "contest",
            },
          },
          { $unwind: "$contest" },
          {
            $project: {
              joinedAt: 1,
              contest: {
                _id: 1,
                title: 1,
                category: 1,
                prize: 1,
                entryFee: 1,
                participationEndAt: 1,
                contestThumbnail: 1,
                status: 1,
              },
            },
          },
          { $sort: { joinedAt: -1 } },
        ];
        const joinedContests = await participantsCollection
          .aggregate(pipeline)
          .toArray();

        res.send(joinedContests);
      } catch (error) {
        console.error("Joined contests error:", error);
        res.status(500).send({ message: "Failed to load joined contests" });
      }
    });

    app.post("/contests", verifyFBToken, async (req, res) => {
      const contestData = req.body;
      contestData.status = "pending";
      const result = await contestsCollection.insertOne(contestData);
      res.send(result);
    });

    app.patch(
      "/creator/contests/:id",
      verifyFBToken,
      verifyCreator,
      async (req, res) => {
        const id = req.params.id;
        const contestDataUpdated = req.body;
        const query = { _id: new ObjectId(id) };
        const updatedDoc = {
          $set: contestDataUpdated,
        };
        const result = await contestsCollection.updateOne(query, updatedDoc);
        res.send(result);
      }
    );
    app.patch(
      "/admin/contests/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const updatedStatus = req.body;
        const query = { _id: new ObjectId(id) };
        const updatedDoc = {
          $set: updatedStatus,
        };
        const result = await contestsCollection.updateOne(query, updatedDoc);
        res.send(result);
      }
    );

    // payment related apis
    app.post("/payment-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const contestQuery = { _id: new ObjectId(paymentInfo.contestId) };
      const contest = await contestsCollection.findOne(contestQuery);
      console.log("contest", contest);

      const amount = parseInt(contest.entryFee) * 100;

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            // Provide the exact Price ID (for example, price_1234) of the product you want to sell
            price_data: {
              currency: "USD",
              unit_amount: amount,
              product_data: {
                name: `Pay for ${contest.title}`,
              },
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.userEmail,
        metadata: {
          contestId: paymentInfo.contestId,
          contestName: paymentInfo.contestName,
        },
        mode: "payment",
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });
      res.send({ url: session.url });
    });

    app.post("/verify-payment", async (req, res) => {
      try {
        const sessionId = req.query.session_id;
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        console.log("session retrieve", session);
        const userEmail = session.customer_email;
        const contestId = session.metadata.contestId;
        const transactionId = session.payment_intent;

        const existingPayment = await paymentsCollection.findOne({
          transactionId,
        });

        if (existingPayment) {
          return res.send({
            success: true,
            alreadyVerified: true,
            transactionId,
          });
        }

        if (session.payment_status === "paid") {
          const payment = {
            amount: session.amount_total / 100,
            currency: session.currency,
            userEmail: session.customer_email,
            contestId: session.metadata.contestId,
            contestName: session.metadata.contestName,
            transactionId: session.payment_intent,
            paymentStatus: session.payment_status,
            paidAt: new Date(),
          };

          const paymentResult = await paymentsCollection.insertOne(payment);

          const existingParticipant = await participantsCollection.findOne({
            contestId,
            userEmail,
          });

          const participant = {
            contestId,
            userEmail,
            paymentId: paymentResult.insertedId,
            joinedAt: new Date(),
          };

          if (!existingParticipant) {
            await participantsCollection.insertOne(participant);
          }

          res.send({
            success: true,
            paymentId: paymentResult.insertedId,
            transactionId,
          });
        }
      } catch (error) {
        console.error("Verify payment error:", error);
        res.status(500).send({ message: "Payment verification failed" });
      }
    });

    //get payments verification
    const { ObjectId } = require("mongodb");

    app.get("/payments/check/:contestId", verifyFBToken, async (req, res) => {
      try {
        const { contestId } = req.params;
        const userEmail = req.user.email;

        // 🔍 Check if user is a participant (joined)
        const participant = await participantsCollection.findOne({
          contestId,
          userEmail,
        });

        if (!participant) {
          return res.send({
            paid: false,
            joined: false,
          });
        }

        // 🔍 Optional: fetch payment info
        const payment = await paymentsCollection.findOne({
          _id: participant.paymentId,
        });

        res.send({
          paid: true,
          joined: true,
          paymentId: participant.paymentId,
          paidAt: payment?.paidAt || null,
        });
      } catch (error) {
        console.error("Payment check error:", error);
        res.status(500).send({ message: "Failed to check payment status" });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
};
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Contesto listening on port ${port}`);
});
