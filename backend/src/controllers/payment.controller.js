import Razorpay from "razorpay";
import crypto from "crypto";
import { ENV } from "../config/env.js";
import { Order } from "../models/order.model.js";
import { Product } from "../models/product.model.js";

const razorpay = new Razorpay({
  key_id: ENV.RAZORPAY_KEY_ID,
  key_secret: ENV.RAZORPAY_KEY_SECRET,
});

export async function createOrder(req, res) {
  try {
    const { cartItems } = req.body;

    if (!cartItems || cartItems.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    // Calculate total from server-side
    let subtotal = 0;
    for (const item of cartItems) {
      const product = await Product.findById(item.product._id);
      if (!product) {
        return res.status(404).json({ error: `Product ${item.product.name} not found` });
      }
      subtotal += product.price * item.quantity;
    }

    const shipping = 10.0;
    const tax = subtotal * 0.08;
    const total = subtotal + shipping + tax;

    const options = {
      amount: Math.round(total * 100), // amount in smallest currency unit
      currency: "USD",
      receipt: `receipt_${Date.now()}`,
    };

    const order = await razorpay.orders.create(options);

    res.status(200).json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: ENV.RAZORPAY_KEY_ID, // Send public key to client
    });
  } catch (error) {
    console.error("Error creating Razorpay order:", error);
    res.status(500).json({ error: "Failed to create order" });
  }
}

export async function verifyPayment(req, res) {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      cartItems,
      shippingAddress,
    } = req.body;
    const user = req.user;

    // 1. Verify Signature
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", ENV.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    // 2. Prevent Duplicate Orders
    const existingOrder = await Order.findOne({ "paymentResult.id": razorpay_payment_id });
    if (existingOrder) {
      return res.status(200).json({ message: "Order already processed" });
    }

    // 3. Re-validate items and calculate price for the DB record
    // (We trust the payment was successful for the amount, but we need to reconstruct the order object)
    let subtotal = 0;
    const validatedItems = [];

    for (const item of cartItems) {
      const product = await Product.findById(item.product._id);
      if (product) {
        subtotal += product.price * item.quantity;
        validatedItems.push({
          product: product._id.toString(),
          name: product.name,
          price: product.price,
          quantity: item.quantity,
          image: product.images[0],
        });

        // Update stock
        await Product.findByIdAndUpdate(product._id, {
          $inc: { stock: -item.quantity },
        });
      }
    }

    const shipping = 10.0;
    const tax = subtotal * 0.08;
    const total = subtotal + shipping + tax;

    // 4. Create Order
    const order = await Order.create({
      user: user._id,
      clerkId: user.clerkId,
      orderItems: validatedItems,
      shippingAddress: shippingAddress,
      paymentResult: {
        id: razorpay_payment_id,
        status: "succeeded",
        update_time: Date.now(),
        email_address: user.email,
      },
      totalPrice: total,
    });

    res.status(200).json({ success: true, orderId: order._id });
  } catch (error) {
    console.error("Error verifying payment:", error);
    res.status(500).json({ error: "Payment verification failed" });
  }
}