# A container like the judge: Ubuntu 20.04, g++ 9.4 and Python 3.8.
#
# It runs on the computer's own architecture. The compiler and the integer sizes match the judge, but times
# can be compared only with each other.
FROM ubuntu:20.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ python3 time \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /work
