FROM node:24-alpine

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./

RUN npm ci

# Bundle app source
COPY . .

# Purely informational! Has no effect on the build command
EXPOSE 3005

CMD [ "node", "server.js" ]