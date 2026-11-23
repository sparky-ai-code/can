#!/bin/sh
# Makes sure docker, runc and crun are present for bench/containers.mjs, and pulls the busybox image. Ubuntu runners only.
# The runner image already has docker and its own runc, and installing Ubuntu's runc package on top replaced it and
# stopped the daemon, so only a missing tool is installed, and docker is started if it is not running.
set -eu

if ! command -v crun >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y crun
fi
if ! command -v runc >/dev/null 2>&1; then
  echo "runc is not on PATH: it normally comes with docker on the runner" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  sudo systemctl start docker
  docker info >/dev/null
fi
docker pull busybox:latest

docker --version
runc --version
crun --version
