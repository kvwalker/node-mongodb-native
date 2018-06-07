'use strict';

const applyWriteConcern = require('../utils').applyWriteConcern;
const Code = require('mongodb-core').BSON.Code;
const Collection = require('../collection');
const crypto = require('crypto');
const Db = require('../db');
const f = require('util').format;
const handleCallback = require('../utils').handleCallback;
const MongoError = require('mongodb-core').MongoError;
const parseIndexOptions = require('../utils').parseIndexOptions;
const ReadPreference = require('mongodb-core').ReadPreference;
const shallowClone = require('../utils').shallowClone;
const convertReadPreference = require('./db_helpers').convertReadPreference;
const debugOptions = require('../utils').debugOptions;
const toError = require('../utils').toError;

const debugFields = [
  'authSource',
  'w',
  'wtimeout',
  'j',
  'native_parser',
  'forceServerObjectId',
  'serializeFunctions',
  'raw',
  'promoteLongs',
  'promoteValues',
  'promoteBuffers',
  'bufferMaxEntries',
  'numberOfRetries',
  'retryMiliSeconds',
  'readPreference',
  'pkFactory',
  'parentDb',
  'promiseLibrary',
  'noListener'
];
// Filter out any write concern options
const illegalCommandFields = [
  'w',
  'wtimeout',
  'j',
  'fsync',
  'autoIndexId',
  'strict',
  'serializeFunctions',
  'pkFactory',
  'raw',
  'readPreference',
  'session'
];

function collections(db, options, callback) {
  options = Object.assign({}, options, { nameOnly: true });
  // Let's get the collection names
  db.listCollections({}, options).toArray((err, documents) => {
    if (err != null) return handleCallback(callback, err, null);
    // Filter collections removing any illegal ones
    documents = documents.filter(doc => {
      return doc.name.indexOf('$') === -1;
    });

    // Return the collection objects
    handleCallback(
      callback,
      null,
      documents.map(d => {
        return new Collection(
          db,
          db.s.topology,
          db.s.databaseName,
          d.name,
          db.s.pkFactory,
          db.s.options
        );
      })
    );
  });
}

function createCollection(db, name, options, callback) {
  // Get the write concern options
  const finalOptions = applyWriteConcern(shallowClone(options), { db: db }, options);

  // Did the user destroy the topology
  if (db.serverConfig && db.serverConfig.isDestroyed()) {
    return callback(new MongoError('topology was destroyed'));
  }

  const listCollectionOptions = Object.assign({}, finalOptions, { nameOnly: true });

  // Check if we have the name
  db
    .listCollections({ name: name }, listCollectionOptions)
    .setReadPreference(ReadPreference.PRIMARY)
    .toArray((err, collections) => {
      if (err != null) return handleCallback(callback, err, null);
      if (collections.length > 0 && finalOptions.strict) {
        return handleCallback(
          callback,
          MongoError.create({
            message: `Collection ${name} already exists. Currently in strict mode.`,
            driver: true
          }),
          null
        );
      } else if (collections.length > 0) {
        try {
          return handleCallback(
            callback,
            null,
            new Collection(db, db.s.topology, db.s.databaseName, name, db.s.pkFactory, options)
          );
        } catch (err) {
          return handleCallback(callback, err);
        }
      }

      // Create collection command
      const cmd = { create: name };

      // Decorate command with writeConcern if supported
      applyWriteConcern(cmd, { db: db }, options);

      // Add all optional parameters
      for (let n in options) {
        if (
          options[n] != null &&
          typeof options[n] !== 'function' &&
          illegalCommandFields.indexOf(n) === -1
        ) {
          cmd[n] = options[n];
        }
      }

      // Force a primary read Preference
      finalOptions.readPreference = ReadPreference.PRIMARY;

      // Execute command
      executeCommand(db, cmd, finalOptions, err => {
        if (err) return handleCallback(callback, err);
        handleCallback(
          callback,
          null,
          new Collection(db, db.s.topology, db.s.databaseName, name, db.s.pkFactory, options)
        );
      });
    });
}

function dropCollection(db, cmd, options, callback) {
  return executeCommand(db, cmd, options, (err, result) => {
    // Did the user destroy the topology
    if (db.serverConfig && db.serverConfig.isDestroyed()) {
      return callback(new MongoError('topology was destroyed'));
    }

    if (err) return handleCallback(callback, err);
    if (result.ok) return handleCallback(callback, null, true);
    handleCallback(callback, null, false);
  });
}

function executeCommand(db, command, options, callback) {
  // Did the user destroy the topology
  if (db.serverConfig && db.serverConfig.isDestroyed())
    return callback(new MongoError('topology was destroyed'));
  // Get the db name we are executing against
  const dbName = options.dbName || options.authdb || db.s.databaseName;

  // If we have a readPreference set
  if (options.readPreference == null && db.s.readPreference) {
    options.readPreference = db.s.readPreference;
  }

  // Convert the readPreference if its not a write
  if (options.readPreference) {
    options.readPreference = convertReadPreference(options.readPreference);
  } else {
    options.readPreference = ReadPreference.primary;
  }

  // Debug information
  if (db.s.logger.isDebug())
    db.s.logger.debug(
      f(
        'executing command %s against %s with options [%s]',
        JSON.stringify(command),
        `${dbName}.$cmd`,
        JSON.stringify(debugOptions(debugFields, options))
      )
    );

  // Execute command
  db.s.topology.command(`${dbName}.$cmd`, command, options, (err, result) => {
    if (err) return handleCallback(callback, err);
    if (options.full) return handleCallback(callback, null, result);
    handleCallback(callback, null, result.result);
  });
}

function executeDbAdminCommand(db, selector, options, callback) {
  db.s.topology.command('admin.$cmd', selector, options, (err, result) => {
    // Did the user destroy the topology
    if (db.serverConfig && db.serverConfig.isDestroyed()) {
      return callback(new MongoError('topology was destroyed'));
    }

    if (err) return handleCallback(callback, err);
    handleCallback(callback, null, result.result);
  });
}
function createIndex(db, name, fieldOrSpec, options, callback) {
  // Get the write concern options
  let finalOptions = Object.assign({}, { readPreference: ReadPreference.PRIMARY }, options);
  finalOptions = applyWriteConcern(finalOptions, { db: db }, options);

  // Ensure we have a callback
  if (finalOptions.writeConcern && typeof callback !== 'function') {
    throw MongoError.create({
      message: 'Cannot use a writeConcern without a provided callback',
      driver: true
    });
  }

  // Did the user destroy the topology
  if (db.serverConfig && db.serverConfig.isDestroyed())
    return callback(new MongoError('topology was destroyed'));

  // Attempt to run using createIndexes command
  createIndexUsingCreateIndexes(db, name, fieldOrSpec, options, (err, result) => {
    if (err == null) return handleCallback(callback, err, result);

    // 67 = 'CannotCreateIndex' (malformed index options)
    // 85 = 'IndexOptionsConflict' (index already exists with different options)
    // 86 = 'IndexKeySpecsConflict' (index already exists with the same name)
    // 11000 = 'DuplicateKey' (couldn't build unique index because of dupes)
    // 11600 = 'InterruptedAtShutdown' (interrupted at shutdown)
    // These errors mean that the server recognized `createIndex` as a command
    // and so we don't need to fallback to an insert.
    if (
      err.code === 67 ||
      err.code === 11000 ||
      err.code === 85 ||
      err.code === 86 ||
      err.code === 11600
    ) {
      return handleCallback(callback, err, result);
    }

    // Create command
    const doc = createCreateIndexCommand(db, name, fieldOrSpec, options);
    // Set no key checking
    finalOptions.checkKeys = false;
    // Insert document
    db.s.topology.insert(
      `${db.s.databaseName}.${Db.SYSTEM_INDEX_COLLECTION}`,
      doc,
      finalOptions,
      (err, result) => {
        if (callback == null) return;
        if (err) return handleCallback(callback, err);
        if (result == null) return handleCallback(callback, null, null);
        if (result.result.writeErrors)
          return handleCallback(callback, MongoError.create(result.result.writeErrors[0]), null);
        handleCallback(callback, null, doc.name);
      }
    );
  });
}

function createIndexUsingCreateIndexes(db, name, fieldOrSpec, options, callback) {
  // Build the index
  const indexParameters = parseIndexOptions(fieldOrSpec);
  // Generate the index name
  const indexName = typeof options.name === 'string' ? options.name : indexParameters.name;
  // Set up the index
  const indexes = [{ name: indexName, key: indexParameters.fieldHash }];
  // merge all the options
  const keysToOmit = Object.keys(indexes[0]).concat([
    'w',
    'wtimeout',
    'j',
    'fsync',
    'readPreference',
    'session'
  ]);

  for (let optionName in options) {
    if (keysToOmit.indexOf(optionName) === -1) {
      indexes[0][optionName] = options[optionName];
    }
  }

  // Get capabilities
  const capabilities = db.s.topology.capabilities();

  // Did the user pass in a collation, check if our write server supports it
  if (indexes[0].collation && capabilities && !capabilities.commandsTakeCollation) {
    // Create a new error
    const error = new MongoError('server/primary/mongos does not support collation');
    error.code = 67;
    // Return the error
    return callback(error);
  }

  // Create command, apply write concern to command
  const cmd = applyWriteConcern({ createIndexes: name, indexes: indexes }, { db: db }, options);

  // ReadPreference primary
  options.readPreference = ReadPreference.PRIMARY;

  // Build the command
  executeCommand(db, cmd, options, (err, result) => {
    if (err) return handleCallback(callback, err, null);
    if (result.ok === 0) return handleCallback(callback, toError(result), null);
    // Return the indexName for backward compatibility
    handleCallback(callback, null, indexName);
  });
}

function createCreateIndexCommand(db, name, fieldOrSpec, options) {
  const indexParameters = parseIndexOptions(fieldOrSpec);
  const fieldHash = indexParameters.fieldHash;

  // Generate the index name
  const indexName = typeof options.name === 'string' ? options.name : indexParameters.name;
  const selector = {
    ns: db.databaseName + '.' + name,
    key: fieldHash,
    name: indexName
  };

  // Ensure we have a correct finalUnique
  const finalUnique = options == null || 'object' === typeof options ? false : options;
  // Set up options
  options = options == null || typeof options === 'boolean' ? {} : options;

  // Add all the options
  const keysToOmit = Object.keys(selector);
  for (let optionName in options) {
    if (keysToOmit.indexOf(optionName) === -1) {
      selector[optionName] = options[optionName];
    }
  }

  if (selector['unique'] == null) selector['unique'] = finalUnique;

  // Remove any write concern operations
  const removeKeys = ['w', 'wtimeout', 'j', 'fsync', 'readPreference'];
  for (let i = 0; i < removeKeys.length; i++) {
    delete selector[removeKeys[i]];
  }

  // Return the command creation selector
  return selector;
}

function ensureIndex(db, name, fieldOrSpec, options, callback) {
  // Get the write concern options
  const finalOptions = applyWriteConcern({}, { db: db }, options);
  // Create command
  const selector = createCreateIndexCommand(db, name, fieldOrSpec, options);
  const index_name = selector.name;

  // Did the user destroy the topology
  if (db.serverConfig && db.serverConfig.isDestroyed())
    return callback(new MongoError('topology was destroyed'));

  // Merge primary readPreference
  finalOptions.readPreference = ReadPreference.PRIMARY;

  // Check if the index already exists
  indexInformation(db, name, finalOptions, (err, indexInformation) => {
    if (err != null && err.code !== 26) return handleCallback(callback, err, null);
    // If the index does not exist, create it
    if (indexInformation == null || !indexInformation[index_name]) {
      createIndex(db, name, fieldOrSpec, options, callback);
    } else {
      if (typeof callback === 'function') return handleCallback(callback, null, index_name);
    }
  });
}

function indexInformation(db, name, options, callback) {
  // If we specified full information
  const full = options['full'] == null ? false : options['full'];

  // Did the user destroy the topology
  if (db.serverConfig && db.serverConfig.isDestroyed())
    return callback(new MongoError('topology was destroyed'));
  // Process all the results from the index command and collection
  const processResults = function(indexes) {
    // Contains all the information
    const info = {};
    // Process all the indexes
    for (let i = 0; i < indexes.length; i++) {
      const index = indexes[i];
      // Let's unpack the object
      info[index.name] = [];
      for (let name in index.key) {
        info[index.name].push([name, index.key[name]]);
      }
    }

    return info;
  };

  // Get the list of indexes of the specified collection
  db
    .collection(name)
    .listIndexes(options)
    .toArray((err, indexes) => {
      if (err) return callback(toError(err));
      if (!Array.isArray(indexes)) return handleCallback(callback, null, []);
      if (full) return handleCallback(callback, null, indexes);
      handleCallback(callback, null, processResults(indexes));
    });
}

function executeAuthCreateUserCommand(db, username, password, options, callback) {
  // Special case where there is no password ($external users)
  if (typeof username === 'string' && password != null && typeof password === 'object') {
    options = password;
    password = null;
  }

  // Unpack all options
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }

  // Error out if we digestPassword set
  if (options.digestPassword != null) {
    throw toError(
      "The digestPassword option is not supported via add_user. Please use db.command('createUser', ...) instead for this option."
    );
  }

  // Get additional values
  const customData = options.customData != null ? options.customData : {};
  let roles = Array.isArray(options.roles) ? options.roles : [];
  const maxTimeMS = typeof options.maxTimeMS === 'number' ? options.maxTimeMS : null;

  // If not roles defined print deprecated message
  if (roles.length === 0) {
    console.log('Creating a user without roles is deprecated in MongoDB >= 2.6');
  }

  // Get the error options
  const commandOptions = { writeCommand: true };
  if (options['dbName']) commandOptions.dbName = options['dbName'];

  // Add maxTimeMS to options if set
  if (maxTimeMS != null) commandOptions.maxTimeMS = maxTimeMS;

  // Check the db name and add roles if needed
  if (
    (db.databaseName.toLowerCase() === 'admin' || options.dbName === 'admin') &&
    !Array.isArray(options.roles)
  ) {
    roles = ['root'];
  } else if (!Array.isArray(options.roles)) {
    roles = ['dbOwner'];
  }

  const digestPassword = db.s.topology.lastIsMaster().maxWireVersion >= 7;

  // Build the command to execute
  let command = {
    createUser: username,
    customData: customData,
    roles: roles,
    digestPassword
  };

  // Apply write concern to command
  command = applyWriteConcern(command, { db: db }, options);

  let userPassword = password;

  if (!digestPassword) {
    // Use node md5 generator
    let md5 = crypto.createHash('md5');
    // Generate keys used for authentication
    md5.update(username + ':mongo:' + password);
    userPassword = md5.digest('hex');
  }

  // No password
  if (typeof password === 'string') {
    command.pwd = userPassword;
  }

  // Force write using primary
  commandOptions.readPreference = ReadPreference.primary;

  // Execute the command
  executeCommand(db, command, commandOptions, (err, result) => {
    if (err && err.ok === 0 && err.code === undefined)
      return handleCallback(callback, { code: -5000 }, null);
    if (err) return handleCallback(callback, err, null);
    handleCallback(
      callback,
      !result.ok ? toError(result) : null,
      result.ok ? [{ user: username, pwd: '' }] : null
    );
  });
}

function executeAuthRemoveUserCommand(db, username, options, callback) {
  if (typeof options === 'function') (callback = options), (options = {});
  options = options || {};

  // Did the user destroy the topology
  if (db.serverConfig && db.serverConfig.isDestroyed())
    return callback(new MongoError('topology was destroyed'));
  // Get the error options
  const commandOptions = { writeCommand: true };
  if (options['dbName']) commandOptions.dbName = options['dbName'];

  // Get additional values
  const maxTimeMS = typeof options.maxTimeMS === 'number' ? options.maxTimeMS : null;

  // Add maxTimeMS to options if set
  if (maxTimeMS != null) commandOptions.maxTimeMS = maxTimeMS;

  // Build the command to execute
  let command = {
    dropUser: username
  };

  // Apply write concern to command
  command = applyWriteConcern(command, { db: db }, options);

  // Force write using primary
  commandOptions.readPreference = ReadPreference.primary;

  // Execute the command
  executeCommand(db, command, commandOptions, (err, result) => {
    if (err && !err.ok && err.code === undefined) return handleCallback(callback, { code: -5000 });
    if (err) return handleCallback(callback, err, null);
    handleCallback(callback, null, result.ok ? true : false);
  });
}

function addUser(db, username, password, options, callback) {
  // Did the user destroy the topology
  if (db.serverConfig && db.serverConfig.isDestroyed())
    return callback(new MongoError('topology was destroyed'));
  // Attempt to execute auth command
  executeAuthCreateUserCommand(db, username, password, options, (err, r) => {
    // We need to perform the backward compatible insert operation
    if (err && err.code === -5000) {
      const finalOptions = applyWriteConcern(shallowClone(options), { db: db }, options);

      // Use node md5 generator
      const md5 = crypto.createHash('md5');
      // Generate keys used for authentication
      md5.update(username + ':mongo:' + password);
      const userPassword = md5.digest('hex');

      // If we have another db set
      const db = options.dbName ? new Db(options.dbName, db.s.topology, db.s.options) : db;

      // Fetch a user collection
      const collection = db.collection(Db.SYSTEM_USER_COLLECTION);

      // Check if we are inserting the first user
      collection.count({}, finalOptions, (err, count) => {
        // We got an error (f.ex not authorized)
        if (err != null) return handleCallback(callback, err, null);
        // Check if the user exists and update i
        collection
          .find({ user: username }, { dbName: options['dbName'] }, finalOptions)
          .toArray(err => {
            // We got an error (f.ex not authorized)
            if (err != null) return handleCallback(callback, err, null);
            // Add command keys
            finalOptions.upsert = true;

            // We have a user, let's update the password or upsert if not
            collection.update(
              { user: username },
              { $set: { user: username, pwd: userPassword } },
              finalOptions,
              err => {
                if (count === 0 && err)
                  return handleCallback(callback, null, [{ user: username, pwd: userPassword }]);
                if (err) return handleCallback(callback, err, null);
                handleCallback(callback, null, [{ user: username, pwd: userPassword }]);
              }
            );
          });
      });

      return;
    }

    if (err) return handleCallback(callback, err);
    handleCallback(callback, err, r);
  });
}

function removeUser(db, username, options, callback) {
  // Attempt to execute command
  executeAuthRemoveUserCommand(db, username, options, (err, result) => {
    if (err && err.code === -5000) {
      const finalOptions = applyWriteConcern(shallowClone(options), { db: db }, options);
      // If we have another db set
      const db = options.dbName ? new Db(options.dbName, db.s.topology, db.s.options) : db;

      // Fetch a user collection
      const collection = db.collection(Db.SYSTEM_USER_COLLECTION);

      // Locate the user
      collection.findOne({ user: username }, finalOptions, (err, user) => {
        if (user == null) return handleCallback(callback, err, false);
        collection.remove({ user: username }, finalOptions, err => {
          handleCallback(callback, err, true);
        });
      });

      return;
    }

    if (err) return handleCallback(callback, err);
    handleCallback(callback, err, result);
  });
}

function dropDatabase(db, cmd, options, callback) {
  executeCommand(db, cmd, options, (err, result) => {
    // Did the user destroy the topology
    if (db.serverConfig && db.serverConfig.isDestroyed()) {
      return callback(new MongoError('topology was destroyed'));
    }

    if (callback == null) return;
    if (err) return handleCallback(callback, err, null);
    handleCallback(callback, null, result.ok ? true : false);
  });
}

function evaluate(db, code, parameters, options, callback) {
  let finalCode = code;
  let finalParameters = [];

  // Did the user destroy the topology
  if (db.serverConfig && db.serverConfig.isDestroyed())
    return callback(new MongoError('topology was destroyed'));

  // If not a code object translate to one
  if (!(finalCode && finalCode._bsontype === 'Code')) finalCode = new Code(finalCode);
  // Ensure the parameters are correct
  if (parameters != null && !Array.isArray(parameters) && typeof parameters !== 'function') {
    finalParameters = [parameters];
  } else if (parameters != null && Array.isArray(parameters) && typeof parameters !== 'function') {
    finalParameters = parameters;
  }

  // Create execution selector
  const cmd = { $eval: finalCode, args: finalParameters };
  // Check if the nolock parameter is passed in
  if (options['nolock']) {
    cmd['nolock'] = options['nolock'];
  }

  // Set primary read preference
  options.readPreference = new ReadPreference(ReadPreference.PRIMARY);

  // Execute the command
  executeCommand(db, cmd, options, (err, result) => {
    if (err) return handleCallback(callback, err, null);
    if (result && result.ok === 1) return handleCallback(callback, null, result.retval);
    if (result)
      return handleCallback(
        callback,
        MongoError.create({ message: `eval failed: ${result.errmsg}`, driver: true }),
        null
      );
    handleCallback(callback, err, result);
  });
}

module.exports = {
  addUser,
  collections,
  createCollection,
  createIndex,
  dropCollection,
  dropDatabase,
  ensureIndex,
  evaluate,
  executeCommand,
  executeDbAdminCommand,
  indexInformation,
  removeUser
};
