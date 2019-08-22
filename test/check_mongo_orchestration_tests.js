'use strict';
const shell = require('shelljs');
if (!shell.test('-e', 'mongo-orchestration')) {
  shell.echo('Mongo-orchestration not found. Installing mongo-orchestration.');
  shell.exec('git clone https://github.com/10gen/mongo-orchestration.git');
  shell.cd('mongo-orchestration');
  shell.exec('pip install . --user');
} else {
  shell.cd('mongo-orchestration');
}
shell.exec('nohup mongo-orchestration start > ./out.log 2> ./err.log < /dev/null &');
shell.echo('finished starting mongo-orchestration');
shell.cd('mongo_orchestration');
//shell.cd('configurations');
shell.exec('mkdir /home/travis/tmp/');
//shell.exec('mkdir /Users/rosemary.yin/tmp')

shell.exec('../scripts/mo configuration/servers/clean.json start');
shell.echo('trying to run mongo --port 27017:')
shell.exec('mongo --port 27017')
shell.echo('finished check mongo orchestration script');
