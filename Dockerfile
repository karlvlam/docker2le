FROM node:7.7.2-alpine

RUN mkdir -p /opt/docker2le
WORKDIR /opt/docker2le

ARG NODE_ENV
ENV NODE_ENV $NODE_ENV
COPY package.json /opt/docker2le
RUN npm install && npm cache clean
COPY docker2le.js /opt/docker2le

CMD [ "node", "/opt/docker2le/docker2le.js" ]
