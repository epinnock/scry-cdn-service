#!/bin/bash

# Scry CDN Service - Cloudflare Deployment Script
# This script helps you deploy to Cloudflare Workers step-by-step

set -e

echo "🚀 Scry CDN Service - Cloudflare Deployment"
echo "==========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Export API token if secrets file exists
if [ -f "secrets/cloudflare.login" ]; then
    echo "Loading API token from secrets/cloudflare.login..."
    source secrets/cloudflare.login
    export CLOUDFLARE_API_TOKEN
    echo -e "${GREEN}✓ API token loaded${NC}"
    echo ""
fi

# Step 1: Check authentication
echo "Step 1: Checking Cloudflare authentication..."
if npx wrangler whoami > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Already authenticated with Cloudflare${NC}"
else
    echo -e "${YELLOW}⚠ Not authenticated. Running 'wrangler login'...${NC}"
    npx wrangler login
fi
echo ""

# Step 2: Create R2 buckets
echo "Step 2: Creating R2 buckets..."
echo -e "${YELLOW}This will create two R2 buckets:${NC}"
echo "  - scry-static-sites (production)"
echo "  - scry-static-sites-preview (staging)"
read -p "Continue? (y/n) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    npx wrangler r2 bucket create scry-static-sites || echo -e "${YELLOW}Bucket may already exist${NC}"
    npx wrangler r2 bucket create scry-static-sites-preview || echo -e "${YELLOW}Bucket may already exist${NC}"
    echo -e "${GREEN}✓ R2 buckets created${NC}"
fi
echo ""

# Step 3: Create KV namespaces
echo "Step 3: Creating KV namespaces..."
echo -e "${YELLOW}Creating production KV namespace...${NC}"
PROD_KV=$(npx wrangler kv:namespace create CDN_CACHE 2>&1 || echo "")
echo "$PROD_KV"

echo -e "${YELLOW}Creating preview KV namespace...${NC}"
PREVIEW_KV=$(npx wrangler kv:namespace create CDN_CACHE --preview 2>&1 || echo "")
echo "$PREVIEW_KV"
echo ""

# Extract IDs (this is a simple extraction, may need adjustment)
PROD_ID=$(echo "$PROD_KV" | grep -oP 'id = "\K[^"]+' || echo "")
PREVIEW_ID=$(echo "$PREVIEW_KV" | grep -oP 'preview_id = "\K[^"]+' || echo "")

echo -e "${GREEN}✓ KV namespaces created${NC}"
echo ""
echo -e "${YELLOW}IMPORTANT: Update cloudflare/wrangler.toml with these values:${NC}"
echo "Production KV ID: $PROD_ID"
echo "Preview KV ID: $PREVIEW_ID"
echo ""
echo "Update these lines in cloudflare/wrangler.toml:"
echo "  Line 33: id = \"$PROD_ID\""
echo "  Line 46: preview_id = \"$PREVIEW_ID\""
echo ""
read -p "Press enter when you've updated wrangler.toml..."

# Step 4: Deploy
echo ""
echo "Step 4: Deploying to Cloudflare Workers..."
echo -e "${YELLOW}Choose deployment environment:${NC}"
echo "  1) Production (recommended for first deployment)"
echo "  2) Staging"
read -p "Enter choice (1 or 2): " -n 1 -r
echo ""

if [[ $REPLY == "1" ]]; then
    echo "Deploying to PRODUCTION..."
    npm run deploy:cloudflare
elif [[ $REPLY == "2" ]]; then
    echo "Deploying to STAGING..."
    npm run deploy:cloudflare:staging
else
    echo -e "${RED}Invalid choice. Exiting.${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}✓ Deployment complete!${NC}"
echo ""
echo "Next steps:"
echo "  1. Configure your domain DNS (see DEPLOYMENT.md Step 5)"
echo "  2. Test the health endpoint: curl https://view-test.yourdomain.com/health"
echo "  3. Upload a test ZIP to R2"
echo "  4. Visit https://view-{uuid}.yourdomain.com"
echo ""
echo "For detailed instructions, see DEPLOYMENT.md"
echo ""
echo "To monitor logs, run: npx wrangler tail --env production"