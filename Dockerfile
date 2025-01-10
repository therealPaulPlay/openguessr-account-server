FROM node:20

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./

RUN npm install

# Bundle app source
COPY . .

# Purely informational! Has no effect on the build command
EXPOSE 3005

CMD [ "node", "server.js" ]