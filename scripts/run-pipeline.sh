#!/bin/bash
set -e
cd "$(dirname "$0")/.."
npm run search
npm run verify
npm run enrich
