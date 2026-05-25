#!/bin/bash
# BrokerAGEnt — VPS deployment script
# Run once on a fresh Ubuntu 22.04 VPS as root, then as your user.
#
# Usage:
#   1. SSH into your VPS
#   2. git clone your repo
#   3. cd brokeragent && cp .env.example .env && nano .env   (fill in keys)
#   4. chmod +x deploy.sh && ./deploy.sh
#   5. Update nginx.conf with your domain, then: sudo certbot --nginx -d your-domain.com

set -e

echo "==> Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "==> Installing PM2..."
sudo npm install -g pm2

echo "==> Installing nginx..."
sudo apt-get install -y nginx certbot python3-certbot-nginx

echo "==> Installing dependencies..."
npm ci --omit=dev

echo "==> Creating logs directory..."
mkdir -p logs

echo "==> Copying nginx config..."
sudo cp nginx.conf /etc/nginx/sites-available/brokeragent
sudo ln -sf /etc/nginx/sites-available/brokeragent /etc/nginx/sites-enabled/brokeragent
sudo rm -f /etc/nginx/sites-enabled/default

echo ""
echo "==> Edit nginx.conf first: replace 'your-domain.com' with your actual domain"
echo "==> Then run:"
echo "    sudo nginx -t && sudo systemctl reload nginx"
echo "    sudo certbot --nginx -d your-domain.com"
echo ""
echo "==> Starting BrokerAGEnt with PM2..."
pm2 start ecosystem.config.js
pm2 save
pm2 startup | tail -1 | sudo bash

echo ""
echo "===================================="
echo "  BrokerAGEnt deployed!"
echo "  Check status: pm2 status"
echo "  View logs:    pm2 logs brokeragent"
echo "  Health:       curl http://localhost:3000/health"
echo "===================================="
