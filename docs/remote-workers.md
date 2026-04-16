# Remote Build Workers

Beachhead can offload Docker image builds to remote machines ("build workers"). Instead of building images on the deployment server, the server enqueues build jobs that workers pick up, build, and push to a shared container registry. The server then pulls the finished images during deployment.

## Architecture

```
┌─────────────┐     poll /api/jobs/next     ┌────────────────┐
│   Worker 1   │ ◄──────────────────────── │                │
│ (any machine)│ ──── docker build + push ─► │    Registry    │
└─────────────┘                             │ (Docker Hub,   │
                                            │  GHCR, etc.)   │
┌─────────────┐     poll /api/jobs/next     │                │
│   Worker 2   │ ◄──────────────────────── │                │
│ (any machine)│ ──── docker build + push ─► └────────────────┘
└─────────────┘                                     │
                                                    │ docker pull
                                                    ▼
                                            ┌────────────────┐
                                            │   Beachhead     │
                                            │    Server       │
                                            └────────────────┘
```

## Prerequisites

On the **worker machine**:

- **Node.js 18+**
- **Docker** (with `docker build` and `docker push` working)
- **Git** (to clone repositories)
- Network access to your Beachhead server and the container registry

On the **Beachhead server**:

- Docker must be able to pull from the same registry the workers push to
- Configure the registry credentials in Settings → Build Configuration

## Step 1: Configure Beachhead Server

1. Open the Beachhead dashboard and navigate to **Settings**
2. Under **Build Configuration**, select **Remote workers**
3. Fill in the registry details:
   - **Registry URL**: The registry prefix for images, e.g. `ghcr.io/myorg` or `registry.example.com/beachhead`
   - **Registry Username**: Your registry username
   - **Registry Password**: Your registry password or access token
4. Click **Save Build Settings**

## Step 2: Create an API Token

The worker authenticates to Beachhead using a JWT token. Generate one by logging in:

```bash
# Replace with your Beachhead server URL and admin credentials
curl -s -X POST https://beachhead.example.com/api/bootstrap/login \
  -H 'Content-Type: application/json' \
  -d '{"username": "admin", "password": "your-password"}' \
  -c -

# The response includes a JWT token in the Set-Cookie header.
# For the worker, extract the token from the response:
TOKEN=$(curl -s -X POST https://beachhead.example.com/api/bootstrap/login \
  -H 'Content-Type: application/json' \
  -d '{"username": "admin", "password": "your-password"}' | jq -r '.token')

echo $TOKEN
```

> **Tip**: Create a dedicated user for the worker (e.g. `worker-01`) in Settings → Users.

## Step 3: Set Up the Worker

### Option A: Install globally via npm link

On the worker machine:

```bash
# Clone the repo (or copy just the worker/ directory)
git clone https://github.com/yourorg/beachhead.git
cd beachhead/worker

# Install globally
npm link

# Configure
export BEACHHEAD_URL="https://beachhead.example.com"
export BEACHHEAD_TOKEN="your-jwt-token"

# Start the worker
beachhead-worker start
```

### Option B: Run directly with Node

```bash
cd beachhead/worker

export BEACHHEAD_URL="https://beachhead.example.com"
export BEACHHEAD_TOKEN="your-jwt-token"

node cli.js start
```

### Option C: Use a config file

Create `~/.beachhead-worker.json`:

```json
{
  "serverUrl": "https://beachhead.example.com",
  "token": "your-jwt-token",
  "workerId": "builder-01",
  "pollInterval": 5000
}
```

Then just run:

```bash
beachhead-worker start
```

### Option D: Run as a Docker container

The worker ships with its own `Dockerfile` and `docker-compose.yml` inside the
`worker/` directory. It needs access to the Docker socket to build and push images.

**On a remote machine:**

Copy the `worker/` directory to the machine, create a `.env` file, and start it:

```bash
cd beachhead/worker

cat > .env << 'EOF'
BEACHHEAD_URL=https://beachhead.example.com
BEACHHEAD_TOKEN=your-jwt-token
BEACHHEAD_WORKER_ID=builder-01
EOF

docker compose up -d

# Check logs
docker compose logs -f
```

**Co-located on the Beachhead server:**

```bash
cd beachhead/worker

cat > .env << 'EOF'
BEACHHEAD_URL=https://beachhead.example.com
BEACHHEAD_TOKEN=your-jwt-token
BEACHHEAD_WORKER_ID=worker-local
EOF

docker compose up -d
```

> **Note**: The worker container mounts the host's Docker socket, so builds
> run on the host Docker daemon. The container itself only needs Node.js,
> Git, and the Docker CLI.

## Step 4: Run as a Service (recommended)

Create a systemd service so the worker starts on boot:

```bash
sudo tee /etc/systemd/system/beachhead-worker.service << 'EOF'
[Unit]
Description=Beachhead Remote Build Worker
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=deploy
Environment=BEACHHEAD_URL=https://beachhead.example.com
Environment=BEACHHEAD_TOKEN=your-jwt-token
Environment=BEACHHEAD_WORKER_ID=builder-01
WorkingDirectory=/opt/beachhead/worker
ExecStart=/usr/bin/node /opt/beachhead/worker/cli.js start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable beachhead-worker
sudo systemctl start beachhead-worker

# Check status
sudo systemctl status beachhead-worker
sudo journalctl -u beachhead-worker -f
```

## Configuration Reference

| Env Variable | Config Key | Description | Default |
|---|---|---|---|
| `BEACHHEAD_URL` | `serverUrl` | Beachhead server URL | (required) |
| `BEACHHEAD_TOKEN` | `token` | JWT token for authentication | (required) |
| `BEACHHEAD_WORKER_ID` | `workerId` | Identifier for this worker | hostname |
| `BEACHHEAD_POLL_INTERVAL` | `pollInterval` | Poll interval in ms | 5000 |
| `BEACHHEAD_WORK_DIR` | `workDir` | Temp directory for builds | /tmp/beachhead-worker |
| `BEACHHEAD_CONFIG` | — | Path to config JSON file | ~/.beachhead-worker.json |

## How It Works

1. When a deployment is triggered with **Build Mode = Remote**:
   - The server reads the app's `docker-compose.yml` and finds services with `build:` directives
   - For each buildable service, a **build job** is created in the database (state: `PENDING`)
   - The server waits (polling every 3s) for all build jobs to complete

2. The worker polls `POST /api/jobs/next`:
   - Claims the next pending job (atomic — no two workers get the same job)
   - Clones the repository at the correct branch
   - Runs `docker build` for the specific service
   - Pushes the image to the configured registry
   - Reports success/failure back to the server

3. Once all images are built and pushed:
   - The server pulls the images
   - Generates a compose override that uses the pre-built images (with `pull_policy: always`)
   - Starts containers with `docker compose up --no-build`
   - Health checks and blue/green swap proceed as normal

## Troubleshooting

**Worker can't connect to server**
- Verify `BEACHHEAD_URL` is correct and accessible from the worker
- Check that the JWT token is valid (test with `beachhead-worker run-once`)

**Docker push fails**
- Ensure Docker is logged in to the registry on the worker machine
- The worker auto-logs in using registry credentials from the server, but you can also manually run `docker login`

**Builds time out**
- The server waits up to 15 minutes for remote builds
- For large images, this may need adjustment (see `BUILD_JOB_TIMEOUT` in `worker.js`)

**Switching back to local builds**
- Go to Settings → Build Configuration → select "Server (local builds)" → Save
- No restart needed — the next deployment will build locally
