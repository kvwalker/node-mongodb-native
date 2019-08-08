'use strict';

const chai = require('chai');
const expect = chai.expect;
const core = require('../../lib/core');
const sessions = core.Sessions;
const TestRunnerContext = require('./runner').TestRunnerContext;
const gatherTestSuites = require('./runner').gatherTestSuites;
const generateTopologyTests = require('./runner').generateTopologyTests;

describe('Transactions', function() {
  const testContext = new TestRunnerContext();

  [
    { name: 'spec tests', specPath: `${__dirname}/spec/transactions` },
    {
      name: 'withTransaction spec tests',
      specPath: `${__dirname}/spec/transactions/convenient-api`
    }
  ].forEach(suiteSpec => {
    describe(suiteSpec.name, function() {
      const testSuites = gatherTestSuites(suiteSpec.specPath);
      after(() => testContext.teardown());
      before(function() {
        return testContext.setup(this.configuration);
      });

      function testFilter(spec) {
        const SKIP_TESTS = [
          // commitTransaction retry seems to be swallowed by mongos in these three cases
          'commitTransaction retry succeeds on new mongos',
          'commitTransaction retry fails on new mongos',
          'unpin after transient error within a transaction and commit',
          'count',
          // This test needs there to be multiple mongoses
          'increment txnNumber',
          // There is something wrong with the distinct command in the runner:
          // it is not failing properly
          'add transient label to connection errors',
          // Skipping this until SPEC-1320 is resolved
          'remain pinned after non-transient error on commit'
        ];

        return SKIP_TESTS.indexOf(spec.description) === -1;
      }

      generateTopologyTests(testSuites, testContext, testFilter);
    });
  });

  describe('withTransaction', function() {
    let session, sessionPool;
    beforeEach(() => {
      const topology = new core.Server();
      sessionPool = new sessions.ServerSessionPool(topology);
      session = new sessions.ClientSession(topology, sessionPool);
    });

    afterEach(() => {
      sessionPool.endAllPooledSessions();
    });

    it('should provide a useful error if a Promise is not returned', {
      metadata: { requires: { topology: ['replicaset', 'sharded'], mongodb: '>=4.1.5' } },
      test: function(done) {
        function fnThatDoesntReturnPromise() {
          return false;
        }

        expect(() => session.withTransaction(fnThatDoesntReturnPromise)).to.throw(
          /must return a Promise/
        );

        session.endSession(done);
      }
    });
  });

  describe('startTransaction', function() {
    it('should error if transactions are not supported', {
      metadata: { requires: { topology: ['sharded'], mongodb: '4.0.x' } },
      test: function(done) {
        const configuration = this.configuration;
        const client = configuration.newClient(configuration.url());

        client.connect((err, client) => {
          const session = client.startSession();
          const db = client.db(configuration.db);
          const coll = db.collection('transaction_error_test');
          coll.insertOne({ a: 1 }, err => {
            expect(err).to.not.exist;
            expect(() => session.startTransaction()).to.throw(
              'Transactions are not supported on sharded clusters in MongoDB < 4.2.'
            );

            session.endSession(() => {
              client.close(done);
            });
          });
        });
      }
    });

    it('should not error if transactions are supported', {
      metadata: { requires: { topology: ['sharded'], mongodb: '>=4.1.0' } },
      test: function(done) {
        const configuration = this.configuration;
        const client = configuration.newClient(configuration.url());

        client.connect((err, client) => {
          const session = client.startSession();
          const db = client.db(configuration.db);
          const coll = db.collection('transaction_error_test');
          coll.insertOne({ a: 1 }, err => {
            expect(err).to.not.exist;
            expect(() => session.startTransaction()).to.not.throw();

            session.endSession(() => {
              client.close(done);
            });
          });
        });
      }
    });
  });

  describe('TransientTransactionError', function() {
    it('should have a TransientTransactionError label inside of a transaction', {
      metadata: { requires: { topology: 'replicaset', mongodb: '>=4.0.0' } },
      test: function(done) {
        const configuration = this.configuration;
        const client = configuration.newClient({ w: 1 }, { useUnifiedTopology: true });

        client.connect((err, client) => {
          const session = client.startSession();
          const db = client.db(configuration.db);
          db.createCollection('transaction_error_test', (err, coll) => {
            expect(err).to.not.exist;
            session.startTransaction();
            coll.insertOne({ a: 1 }, { session }, err => {
              expect(err).to.not.exist;
              expect(session.inTransaction()).to.be.true;

              db.executeDbAdminCommand(
                {
                  configureFailPoint: 'failCommand',
                  mode: { times: 2 },
                  data: { failCommands: ['commitTransaction'], closeConnection: true }
                },
                () => {
                  expect(session.inTransaction()).to.be.true;
                  session.commitTransaction(err => {
                    expect(err).to.exist;
                    expect(err.errorLabels).to.deep.equal(['UnknownTransactionCommitResult']);
                    db.executeDbAdminCommand(
                      { configureFailPoint: 'failCommand', mode: 'off' },
                      () => {
                        client.close(done);
                      }
                    );
                  });
                }
              );
            });
          });
        });
      }
    });

    it('should not have a TransientTransactionError label outside of a transaction', {
      metadata: { requires: { topology: 'replicaset', mongodb: '>=4.0.0' } },
      test: function(done) {
        const configuration = this.configuration;
        const client = configuration.newClient({ w: 1 }, { useUnifiedTopology: true });

        client.connect((err, client) => {
          const db = client.db(configuration.db);
          const coll = db.collection('transaction_error_test1');

          db.executeDbAdminCommand(
            {
              configureFailPoint: 'failCommand',
              mode: 'alwaysOn',
              data: { failCommands: ['insert'], closeConnection: true }
            },
            () => {
              coll.insertOne({ a: 1 }, err => {
                expect(err).to.exist;
                expect(err.errorLabels).to.not.exist;
                db.executeDbAdminCommand({ configureFailPoint: 'failCommand', mode: 'off' }, () => {
                  client.close(done);
                });
              });
            }
          );
        });
      }
    });
  });
});
