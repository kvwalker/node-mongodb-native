#!/bin/bash

result=`which mongo-orchestration`
if [[ -z "$result" ]]; then
  echo Mongo-orchestration not found. Installing mongo-orchestration.
  git clone https://github.com/10gen/mongo-orchestration.git
  mongo-orchestration stop
fi
mongo-orchestration start
cd ../../mongo-orchestration/mongo_orchestration
../scripts/mo configurations/servers/clean.json start
echo 'finished check mongo orchestration script'
