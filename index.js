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
    const submissionsCollection = database.collection("submissions");

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

    app.get("/user/profile", verifyFBToken, async (req, res) => {
      try {
        const email = req.query.email;
        if (!email || email !== req.user.email) {
          return res.status(403).send({ message: "Forbidden access" });
        }

        const user = await usersCollection.findOne({ email });

        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send(user);
      } catch (error) {
        res.status(500).send({ message: "Failed to load user profile" });
      }
    });

    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });

    app.get("/user-win-category-stats", verifyFBToken, async (req, res) => {
      try {
        const { email } = req.query;

        if (!email) {
          return res.status(400).send({ message: "Email is required" });
        }

        //Category-wise WIN stats
        const categoryPipeline = [
          {
            $match: {
              userEmail: email,
              status: "winner",
            },
          },
          {
            $lookup: {
              from: "contests",
              localField: "contestId",
              foreignField: "_id",
              as: "contest",
            },
          },
          { $unwind: "$contest" },
          {
            $group: {
              _id: "$contest.category",
              winCount: { $sum: 1 },
            },
          },
          {
            $project: {
              _id: 0,
              category: "$_id",
              winCount: 1,
            },
          },
        ];

        //Win / Lost totals
        const resultPipeline = [
          {
            $match: {
              userEmail: email,
              status: { $in: ["winner", "lost"] },
            },
          },
          {
            $group: {
              _id: "$status",
              count: { $sum: 1 },
            },
          },
        ];

        const [categoryStats, resultStats] = await Promise.all([
          submissionsCollection.aggregate(categoryPipeline).toArray(),
          submissionsCollection.aggregate(resultPipeline).toArray(),
        ]);

        let win = 0;
        let lost = 0;

        resultStats.forEach((item) => {
          if (item._id === "winner") win = item.count;
          if (item._id === "lost") lost = item.count;
        });

        const total = win + lost;

        res.send({
          summary: {
            win,
            lost,
            winRate: total ? +((win / total) * 100).toFixed(1) : 0,
            lostRate: total ? +((lost / total) * 100).toFixed(1) : 0,
            total,
          },
          categoryStats,
        });
      } catch (error) {
        res.status(500).send({ message: "Failed to load dashboard stats" });
      }
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

    app.patch("/user/profile", verifyFBToken, async (req, res) => {
      try {
        const email = req.user.email;
        const { name, photoURL, address, bio } = req.body;

        if (!name && !photoURL) {
          return res
            .status(400)
            .send({ message: "No fields provided to update" });
        }
        const updateDoc = {};
        if (name) updateDoc.name = name;
        if (photoURL) updateDoc.photoURL = photoURL;
        if (address) updateDoc.address = address;
        if (bio) updateDoc.bio = bio;

        const result = await usersCollection.updateOne(
          { email },
          { $set: updateDoc }
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send({
          message: "Profile updated successfully",
          modifiedCount: result.modifiedCount,
        });
      } catch (error) {
        res.status(500).send({ message: "Failed to update profile" });
      }
    });

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
      try {
        const { category } = req.query;

        const matchStage = {
          status: "approved",
          contestStatus: "open",
        };

        if (category && category !== "All") {
          matchStage.category = category;
        }

        const contests = await contestsCollection
          .aggregate([
            {
              $match: matchStage,
            },
            {
              $lookup: {
                from: "participants",
                localField: "_id",
                foreignField: "contestId",
                as: "participants",
              },
            },
            {
              $addFields: {
                participantCount: {
                  $size: "$participants",
                },
              },
            },
            {
              $project: {
                participants: 0,
              },
            },
            {
              $sort: { participationEndAt: -1 },
            },
          ])
          .toArray();

        res.send(contests);
      } catch (error) {
        console.error("Load contests error:", error);
        res.status(500).send({ message: "Failed to load contests" });
      }
    });

    app.get("/contests/popular", async (req, res) => {
      try {
        const popularContests = await contestsCollection
          .aggregate([
            {
              $match: { status: "approved", contestStatus: "open" },
            },
            {
              $lookup: {
                from: "participants",
                localField: "_id",
                foreignField: "contestId",
                as: "participants",
              },
            },
            {
              $addFields: {
                participantCount: {
                  $size: "$participants",
                },
              },
            },
            {
              $sort: { participantCount: -1 },
            },
            {
              $limit: 8,
            },
            {
              $project: {
                participants: 0,
              },
            },
          ])
          .toArray();

        res.send(popularContests);
      } catch (error) {
        res.status(500).send({ message: "Failed to load popular contests" });
      }
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
              from: "submissions",
              localField: "contestId",
              foreignField: "contestId",
              as: "submission",
            },
          },

          {
            $addFields: {
              submission: {
                $filter: {
                  input: "$submission",
                  as: "s",
                  cond: { $eq: ["$$s.userEmail", userEmail] },
                },
              },
            },
          },

          {
            $unwind: {
              path: "$submission",
              preserveNullAndEmptyArrays: true,
            },
          },

          {
            $lookup: {
              from: "contests",
              localField: "contestId",
              foreignField: "_id",
              as: "contest",
            },
          },
          { $unwind: "$contest" },

          {
            $project: {
              joinedAt: 1,
              submissionStatus: {
                $ifNull: ["$submission.status", "pending"],
              },
              contest: {
                _id: "$contest._id",
                title: "$contest.title",
                category: "$contest.category",
                prize: "$contest.prize",
                entryFee: "$contest.entryFee",
                participationEndAt: "$contest.participationEndAt",
                contestThumbnail: "$contest.contestThumbnail",
                contestStatus: "$contest.contestStatus",
              },
            },
          },

          {
            $sort: { joinedAt: -1 },
          },
        ];

        const joinedContests = await participantsCollection
          .aggregate(pipeline)
          .toArray();

        res.send(joinedContests);
      } catch (error) {
        res.status(500).send({ message: "Failed to load joined contests" });
      }
    });

    app.get(
      "/contests/:id/participants-count",
      verifyFBToken,
      async (req, res) => {
        try {
          const { id } = req.params;
          const count = await participantsCollection.countDocuments({
            contestId: new ObjectId(id),
          });

          res.send({ count });
        } catch (error) {
          res.status(500).send({ message: "Failed to get participant count" });
        }
      }
    );

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
          $set: { status: updatedStatus.status, contestStatus: "open" },
        };
        const result = await contestsCollection.updateOne(query, updatedDoc);
        res.send(result);
      }
    );

    app.delete(
      "/contests/:id",
      verifyFBToken,
      verifyCreator,
      async (req, res) => {
        try {
          const id = req.params.id;
          const result = await contestsCollection.deleteOne({
            _id: new ObjectId(id),
          });
          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "Failed to delete contest" });
        }
      }
    );

    // payment related apis
    app.post("/payment-checkout-session", verifyFBToken, async (req, res) => {
      const paymentInfo = req.body;
      const email = req.user.email;
      const contestQuery = { _id: new ObjectId(paymentInfo.contestId) };
      const contest = await contestsCollection.findOne(contestQuery);

      const user = await usersCollection.findOne({ email });
      console.log(user);

      if (user.role === "admin") {
        return res.status(403).send({ error: "Admin cannot join contest" });
      }
      if (user.role === "creator") {
        return res.status(403).send({ error: "Creators cannot join contest" });
      }

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
            contestId: new ObjectId(contestId),
            userEmail,
          });

          const participant = {
            contestId: new ObjectId(contestId),
            userEmail,
            paymentId: paymentResult.insertedId.toString(),
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
        res.status(500).send({ message: "Payment verification failed" });
      }
    });

    //get payments verification
    app.get("/payments/check/:contestId", verifyFBToken, async (req, res) => {
      try {
        const { contestId } = req.params;
        const userEmail = req.user.email;

        const participant = await participantsCollection.findOne({
          contestId: new ObjectId(contestId),
          userEmail,
        });

        if (!participant) {
          return res.send({
            paid: false,
            joined: false,
          });
        }

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
        res.status(500).send({ message: "Failed to check payment status" });
      }
    });

    // submission related apis
    app.get(
      "/creator/contests/:contestId/submissions",
      verifyFBToken,
      verifyCreator,
      async (req, res) => {
        const { contestId } = req.params;

        const submissions = await submissionsCollection
          .aggregate([
            {
              $match: {
                contestId: new ObjectId(contestId),
              },
            },
            {
              $lookup: {
                from: "users",
                localField: "userEmail",
                foreignField: "email",
                as: "user",
              },
            },
            { $unwind: "$user" },
            {
              $project: {
                submissionValue: 1,
                status: 1,
                submittedAt: 1,
                "user.name": 1,
                "user.email": 1,
                "user.photoURL": 1,
              },
            },
          ])
          .toArray();

        res.send(submissions);
      }
    );

    app.get("/submissions/me", verifyFBToken, async (req, res) => {
      try {
        const { contestId } = req.query;
        const userEmail = req.user.email;

        const submission = await submissionsCollection.findOne({
          contestId: new ObjectId(contestId),
          userEmail,
        });

        if (!submission) {
          return res.send({ submitted: false });
        }

        res.send({
          submitted: true,
          submission,
        });
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch submission" });
      }
    });

    app.post("/submissions", verifyFBToken, async (req, res) => {
      try {
        const { contestId, submissionValue } = req.body;
        const userEmail = req.user.email;

        const contest = await contestsCollection.findOne({
          _id: new ObjectId(contestId),
        });

        if (contest.contestStatus !== "open") {
          return res.status(403).send({
            message: "Contest is closed for submissions",
          });
        }

        const participant = await participantsCollection.findOne({
          contestId: new ObjectId(contestId),
          userEmail,
        });

        if (!participant) {
          return res.status(403).send({
            message: "You must join the contest before submitting",
          });
        }

        const existingSubmission = await submissionsCollection.findOne({
          contestId: new ObjectId(contestId),
          userEmail,
        });

        if (existingSubmission) {
          return res.status(409).send({
            message: "You have already submitted",
          });
        }

        const submission = {
          contestId: new ObjectId(contestId),
          userEmail,
          participantId: participant._id,
          submissionValue,
          status: "pending",
          submittedAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await submissionsCollection.insertOne(submission);

        res.send({
          success: true,
          submissionId: result.insertedId,
        });
      } catch (error) {
        res.status(500).send({ message: "Failed to submit contest entry" });
      }
    });

    app.patch(
      "/creator/contests/:contestId/winner/:submissionId",
      verifyFBToken,
      verifyCreator,
      async (req, res) => {
        try {
          const { contestId, submissionId } = req.params;

          if (!ObjectId.isValid(contestId) || !ObjectId.isValid(submissionId)) {
            return res.status(400).send({ message: "Invalid ID" });
          }

          const contest = await contestsCollection.findOne({
            _id: new ObjectId(contestId),
          });

          if (!contest) {
            return res.status(404).send({ message: "Contest not found" });
          }

          const now = new Date();
          const endTime = new Date(contest.participationEndAt);

          if (now < endTime) {
            return res.status(400).send({
              message: "You cannot announce the winner before the contest ends",
            });
          }

          if (contest.contestStatus === "completed") {
            return res.status(409).send({
              message: "Winner already selected for this contest",
            });
          }

          const updateWinner = await submissionsCollection.updateOne(
            {
              _id: new ObjectId(submissionId),
              contestId: new ObjectId(contestId),
              status: "pending",
            },
            {
              $set: {
                status: "winner",
                updatedAt: new Date(),
              },
            }
          );

          if (updateWinner.matchedCount === 0) {
            return res.status(400).send({
              message: "Submission not found or already processed",
            });
          }

          await submissionsCollection.updateMany(
            {
              contestId: new ObjectId(contestId),
              _id: { $ne: new ObjectId(submissionId) },
              status: "pending",
            },
            {
              $set: {
                status: "lost",
                updatedAt: new Date(),
              },
            }
          );

          await contestsCollection.updateOne(
            { _id: new ObjectId(contestId) },
            {
              $set: {
                contestStatus: "completed",
              },
            }
          );

          res.send({
            success: true,
            message: "Winner selected successfully",
          });
        } catch (error) {
          res.status(500).send({
            message: "Failed to select winner",
          });
        }
      }
    );

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
