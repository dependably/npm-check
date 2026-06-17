ARG NODE_VERSION=18
FROM node:${NODE_VERSION}-alpine

# Install git for git dependencies
RUN apk add --no-cache git

# Set working directory
WORKDIR /workspace

# Install npm globally (can override version)
ARG NPM_VERSION=latest
RUN if [ "$NPM_VERSION" != "latest" ]; then \
      npm install -g npm@${NPM_VERSION}; \
    fi

# Copy npm-check source
COPY package.json package-lock.json ./
COPY src/ ./src/
COPY bin/ ./bin/

# Install dependencies
RUN npm ci

# Copy test infrastructure
COPY tests/ ./tests/

# Set entrypoint
ENTRYPOINT ["/workspace/tests/integration/docker/entrypoint.sh"]
CMD ["npm", "run", "test:integration"]
