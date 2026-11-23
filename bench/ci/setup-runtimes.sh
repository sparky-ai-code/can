#!/bin/sh
# Installs the OCI runtimes (runc, crun) and pulls the busybox image for bench/containers.mjs. Ubuntu runners only.
set -eu

sudo apt-get update
sudo apt-get install -y crun runc
docker pull busybox:latest

docker --version
runc --version
crun --version
