import express, { Request, Response, NextFunction } from 'express';
import { Octokit } from '@octokit/rest';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import winston from 'winston';
import dotenv from 'dotenv';

dotenv.config();

// Logger configuration
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 1000, // Limit each IP to 1000 requests per hour
  message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// API Key authentication middleware
const authenticateAPI = (req: Request, res: Response, next: NextFunction) => {
  const apiKey = req.headers['x-api-key'];
  
  if (!apiKey || apiKey !== process.env.MCP_API_KEY) {
    logger.warn('Unauthorized API access attempt', {
      ip: req.ip,
      path: req.path
    });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  next();
};

// Apply auth to all routes except health
app.use((req, res, next) => {
  if (req.path === '/health') {
    return next();
  }
  authenticateAPI(req, res, next);
});

// Initialize Octokit
const getOctokit = () => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN not configured');
  }
  return new Octokit({ auth: token });
};

// Health check endpoint
app.get('/health', async (req: Request, res: Response) => {
  try {
    const octokit = getOctokit();
    const { data: user } = await octokit.users.getAuthenticated();
    
    res.json({
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      github: {
        connected: true,
        user: user.login,
        rateLimit: 'available'
      }
    });
  } catch (error) {
    logger.error('Health check failed', { error });
    res.status(503).json({
      status: 'unhealthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      github: {
        connected: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    });
  }
});

// Create repository
app.post('/api/repos/create', async (req: Request, res: Response) => {
  try {
    const { name, description, private: isPrivate = false, autoInit = true } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Repository name is required' });
    }
    
    const octokit = getOctokit();
    const org = process.env.GITHUB_ORG;
    
    logger.info('Creating repository', { name, org });
    
    let repo;
    if (org) {
      // Create in organization
      repo = await octokit.repos.createInOrg({
        org,
        name,
        description: description || '',
        private: isPrivate,
        auto_init: autoInit
      });
    } else {
      // Create in user account
      repo = await octokit.repos.createForAuthenticatedUser({
        name,
        description: description || '',
        private: isPrivate,
        auto_init: autoInit
      });
    }
    
    logger.info('Repository created successfully', {
      name: repo.data.name,
      url: repo.data.html_url
    });
    
    res.json({
      success: true,
      repository: {
        name: repo.data.name,
        fullName: repo.data.full_name,
        url: repo.data.html_url,
        cloneUrl: repo.data.clone_url,
        sshUrl: repo.data.ssh_url,
        defaultBranch: repo.data.default_branch
      }
    });
  } catch (error) {
    logger.error('Failed to create repository', { error });
    res.status(500).json({
      error: 'Failed to create repository',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Commit files to repository
app.post('/api/repos/:owner/:repo/commit', async (req: Request, res: Response) => {
  try {
    const { owner, repo } = req.params;
    const { files, message, branch = 'main' } = req.body;
    
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'Files array is required' });
    }
    
    if (!message) {
      return res.status(400).json({ error: 'Commit message is required' });
    }
    
    const octokit = getOctokit();
    
    logger.info('Creating commit', { owner, repo, branch, fileCount: files.length });
    
    // Get current commit SHA
    const { data: refData } = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${branch}`
    });
    
    const currentCommitSha = refData.object.sha;
    
    // Get current tree
    const { data: currentCommit } = await octokit.git.getCommit({
      owner,
      repo,
      commit_sha: currentCommitSha
    });
    
    const currentTreeSha = currentCommit.tree.sha;
    
    // Create blobs for all files
    const blobs = await Promise.all(
      files.map(async (file: { path: string; content: string }) => {
        const { data: blob } = await octokit.git.createBlob({
          owner,
          repo,
          content: Buffer.from(file.content).toString('base64'),
          encoding: 'base64'
        });
        
        return {
          path: file.path,
          mode: '100644' as const,
          type: 'blob' as const,
          sha: blob.sha
        };
      })
    );
    
    // Create new tree
    const { data: newTree } = await octokit.git.createTree({
      owner,
      repo,
      base_tree: currentTreeSha,
      tree: blobs
    });
    
    // Create new commit
    const { data: newCommit } = await octokit.git.createCommit({
      owner,
      repo,
      message,
      tree: newTree.sha,
      parents: [currentCommitSha]
    });
    
    // Update reference
    await octokit.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: newCommit.sha
    });
    
    logger.info('Commit created successfully', {
      owner,
      repo,
      sha: newCommit.sha
    });
    
    res.json({
      success: true,
      commit: {
        sha: newCommit.sha,
        message: newCommit.message,
        url: newCommit.html_url,
        branch
      }
    });
  } catch (error) {
    logger.error('Failed to create commit', { error });
    res.status(500).json({
      error: 'Failed to create commit',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get repository status
app.get('/api/repos/:owner/:repo/status', async (req: Request, res: Response) => {
  try {
    const { owner, repo } = req.params;
    const octokit = getOctokit();
    
    const { data: repository } = await octokit.repos.get({
      owner,
      repo
    });
    
    const { data: branches } = await octokit.repos.listBranches({
      owner,
      repo
    });
    
    const { data: commits } = await octokit.repos.listCommits({
      owner,
      repo,
      per_page: 10
    });
    
    res.json({
      success: true,
      repository: {
        name: repository.name,
        fullName: repository.full_name,
        description: repository.description,
        url: repository.html_url,
        private: repository.private,
        defaultBranch: repository.default_branch,
        createdAt: repository.created_at,
        updatedAt: repository.updated_at
      },
      branches: branches.map(b => ({
        name: b.name,
        protected: b.protected
      })),
      recentCommits: commits.map(c => ({
        sha: c.sha.substring(0, 7),
        message: c.commit.message,
        author: c.commit.author?.name || 'Unknown',
        date: c.commit.author?.date || new Date().toISOString()
      }))
    });
  } catch (error) {
    logger.error('Failed to get repository status', { error });
    res.status(500).json({
      error: 'Failed to get repository status',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Create branch
app.post('/api/repos/:owner/:repo/branch', async (req: Request, res: Response) => {
  try {
    const { owner, repo } = req.params;
    const { name, from = 'main' } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Branch name is required' });
    }
    
    const octokit = getOctokit();
    
    // Get the SHA of the branch to create from
    const { data: refData } = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${from}`
    });
    
    // Create new branch
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${name}`,
      sha: refData.object.sha
    });
    
    logger.info('Branch created successfully', { owner, repo, branch: name });
    
    res.json({
      success: true,
      branch: {
        name,
        from,
        sha: refData.object.sha
      }
    });
  } catch (error) {
    logger.error('Failed to create branch', { error });
    res.status(500).json({
      error: 'Failed to create branch',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Create pull request
app.post('/api/repos/:owner/:repo/pr', async (req: Request, res: Response) => {
  try {
    const { owner, repo } = req.params;
    const { title, head, base = 'main', body } = req.body;
    
    if (!title || !head) {
      return res.status(400).json({
        error: 'Title and head branch are required'
      });
    }
    
    const octokit = getOctokit();
    
    const { data: pr } = await octokit.pulls.create({
      owner,
      repo,
      title,
      head,
      base,
      body: body || ''
    });
    
    logger.info('Pull request created', {
      owner,
      repo,
      number: pr.number,
      url: pr.html_url
    });
    
    res.json({
      success: true,
      pullRequest: {
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        state: pr.state,
        head: pr.head.ref,
        base: pr.base.ref
      }
    });
  } catch (error) {
    logger.error('Failed to create pull request', { error });
    res.status(500).json({
      error: 'Failed to create pull request',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Delete repository (with safety checks)
app.delete('/api/repos/:owner/:repo', async (req: Request, res: Response) => {
  try {
    const { owner, repo } = req.params;
    const { confirm } = req.body;
    
    if (confirm !== repo) {
      return res.status(400).json({
        error: 'Repository name confirmation required',
        message: 'Send { "confirm": "repository-name" } to delete'
      });
    }
    
    const octokit = getOctokit();
    
    await octokit.repos.delete({
      owner,
      repo
    });
    
    logger.warn('Repository deleted', { owner, repo });
    
    res.json({
      success: true,
      message: `Repository ${owner}/${repo} deleted successfully`
    });
  } catch (error) {
    logger.error('Failed to delete repository', { error });
    res.status(500).json({
      error: 'Failed to delete repository',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get GitHub rate limit status
app.get('/api/rate-limit', async (req: Request, res: Response) => {
  try {
    const octokit = getOctokit();
    const { data: rateLimit } = await octokit.rateLimit.get();
    
    res.json({
      success: true,
      rateLimit: {
        core: {
          limit: rateLimit.resources.core.limit,
          remaining: rateLimit.resources.core.remaining,
          reset: new Date(rateLimit.resources.core.reset * 1000).toISOString()
        },
        graphql: {
          limit: rateLimit.resources.graphql?.limit || 0,
          remaining: rateLimit.resources.graphql?.remaining || 0,
          reset: rateLimit.resources.graphql?.reset 
            ? new Date(rateLimit.resources.graphql.reset * 1000).toISOString()
            : new Date().toISOString()
        }
      }
    });
  } catch (error) {
    logger.error('Failed to get rate limit', { error });
    res.status(500).json({
      error: 'Failed to get rate limit',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Error handling middleware
app.use((error: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error('Unhandled error', {
    error: error.message,
    stack: error.stack,
    path: req.path
  });
  
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : undefined
  });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`GitHub MCP Server running on port ${PORT}`);
  logger.info('GitHub org:', process.env.GITHUB_ORG || 'Personal account');
  logger.info('Endpoints: /health, /api/repos/*, /api/rate-limit');
});

export default app;
