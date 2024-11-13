//main.js

import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import express from 'express';
import cookieParser from 'cookie-parser';
import { connectMongoDB, User, Blog } from './database/database.js';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import slugify from 'slugify';

const app = express();

// Security middleware
app.use(helmet());
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());

//Rate limitng
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
});

app.use('/api', limiter);

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('JWT_SECRET not set in environmental variable');
    process.exit(1);
}

// Middleware for error handling
const asyncHandler = fn => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

app.get('/', (_req, res) => {
    res.json({ message: "Index Page" });
});

app.post('/api/register', asyncHandler(async (req, res) => {
    const { username, password, email } = req.body;

    const existingUser = await User.findOne({
        $or: [{ email }, { username }]
    });

    if (existingUser) {
        return res.status(400).json({
            message: "User with this email or username already exists"
        });
    }
    const hashedPAssword = await bcrypt.hash(password, 12);
    const newUser = new User({
        username,
        email,
        password: hashedPAssword
    });

    await newUser.save();

    // Not sending password back in response
    newUser.password = undefined;

    res.status(201).json({
        message: "User created successfully:",
        user: newUser
    });
}));

app.post('/api/login', asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({
            message: "Invalid credentials"
        });
    }

    user.lastLogin = new Date();
    await user.save();

    const token = jwt.sign(
        {
            userId: user.id,
            role: user.role,
            email: user.email
        },
        JWT_SECRET,
        { expiresIn: '1h' });

    // Set secure cookie
    res.cookie('token', token, {
        maxAge: 1000 * 60 * 60,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict'
    });

    res.status(200).json({
        message: "Login successful",
        user: {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role,
        }
    });
}));

const authenticateToken = (req, res, next) => {
    const token = req.cookies.token;

    if (!token) {
        return res.status(401).json({ message: "Authenticarion required" });
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded; // Attach decode user info to req object
        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ message: "Token Expired" });
        }
        return res.status(403).json({ message: "Invalid token" });
    }
}

// Role-based authorization middleware
app.get('/protected', authenticateToken, (req, res) => {
    res.json({ message: "This is protected data", user: req.user });
});


// Blog API
const authorizeRole = role => (req, res, next) => {
    if (req.user.role != role) {
        return res.status(403).json({ message: "Access denied" });
    }
    next();
}

const generateUniqueSlug = async (title) => {
    let slug = slugify(title, { lower: true });
    let exists = await Blog.findOne({ slug });
    let count = 1;

    while (exists) {
        slug = `${slugify(title, { lower: true })}-${count}`;
        exists = await Blog.findOne({ slug });
        count++;
    }

    return slug;
};

// Post a blog
app.post('/api/blogs', authenticateToken, authorizeRole('author'), asyncHandler(async (req, res) => {
    const { title, subtitle, content } = req.body;

    const user = await User.findOne({ id: req.user.userId });
    if (!user) return res.status(401).json({ message: "Invalid credentials" });

    const slug = await generateUniqueSlug(title);

    const newBlog = Blog({
        title,
        subtitle,
        content,
        slug,
        author: user._id
    });

    await newBlog.save();
    res.status(201).json({ message: "Blog post created", blog: newBlog });
}));

// Update a blog
app.delete('/api/blogs/:slug', authenticateToken, authorizeRole('author'), asyncHandler(async (req, res) => {
    const { slug } = req.params;

    const blog = await Blog.findOneAndDelete({ slug });
    if (!blog) return res.status(404).json({ message: "Blog not found or not authorized" });

    res.status(200).json({ message: 'Blog deleted' });
}))


// Search and GET all published post
app.get('/api/blogs', asyncHandler(async (_req, res) => {
    const publishedBlogs = await Blog.find({ status: 'draft' })
        .sort({ createdAt: -1 })
        .select('-__v -comments -author');

    res.status(200).json({
        message: "List of published posts",
        blogs: publishedBlogs
    });
}));

// Search and GET post by author name
app.get('/api/blogs/author/:username', asyncHandler(async (req, res) => {
    const { username } = req.params;

    const user = await User.findOne({ username });
    if (!user) return res.status(401).json({ message: "Author not found" });

    // Find published posts by this author
    const authorBlogs = await Blog.find({ status: 'draft', author: user._id })
        .sort({ createdAt: -1 })
        .select('-__v -comments');

    res.status(200).json({
        message: `List of published posts by ${username}`,
        blog: authorBlogs
    })
}));

connectMongoDB();

app.listen(3000, () => {
    console.log(`Listening live at port ${process.env.PORT}`);
});
