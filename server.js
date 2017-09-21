/**
# Copyright 2017 IBM Corp. All Rights Reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
*/
var express = require('express')
, passwordHash = require('password-hash')
, cookieParser = require('cookie-parser')
, bodyParser   = require('body-parser')
, session      = require('express-session')
, sh           = require("shorthash")
, cfenv        = require('cfenv')
, Client       = require('node-rest-client').Client;
var app = express();
var appEnv = cfenv.getAppEnv();

var port = appEnv.port || 8080;

// application constants
const BANK_CODE = '123456780';
const ORGANIZATION_ID = 'FGB';
const PARTNER_TYPE = 1;
const APPLICATION_NAME = 'SampleApp';
const GENERATED = 'generated';
const BLUEMIX_SERVICE_NAME = 'zelle-real-time-payments-service';

// REST APIs
var serviceBrokerUri         = 'http://localhost'; // in case you're not running in BlueMix
var serviceBrokerAccessToken = null;               // in case you're not running in BlueMix
if(	appEnv &&
	appEnv.services &&
	appEnv.services[BLUEMIX_SERVICE_NAME] &&
	appEnv.services[BLUEMIX_SERVICE_NAME][0] &&
	appEnv.services[BLUEMIX_SERVICE_NAME][0]['credentials'] ) {
		if( appEnv.services[BLUEMIX_SERVICE_NAME][0]['credentials']['uri']) {
			serviceBrokerUri = appEnv.services[BLUEMIX_SERVICE_NAME][0]['credentials']['uri'];
		}
		if( appEnv.services[BLUEMIX_SERVICE_NAME][0]['credentials']['accessToken']) {
			serviceBrokerAccessToken = appEnv.services[BLUEMIX_SERVICE_NAME][0]['credentials']['accessToken'];
		}
}

var serviceBrokerRequestParameters = {
    //user:     todo, // basic http auth username if required
    //password: todo  // basic http auth password if required
};
const ftmBaseUrl = serviceBrokerUri + '/fxh/svc/';
const ddaBaseUrl = serviceBrokerUri + '/api/';

const GET_HEADERS = {
						'accept': 'application/json',
						'X-IBM-Access-Token' : serviceBrokerAccessToken
					};

const DDA_POST_HEADERS = {
							'content-type': 'application/json',
							'accept': 'application/json',
							'X-IBM-Access-Token' : serviceBrokerAccessToken
						 };

const FTM_POST_HEADERS = {
						   'content-type': 'application/json',
						   'accept': 'application/json',
						   'X-IBM-Access-Token' : serviceBrokerAccessToken,
						   'x-csrf-protection': 1					// You'll get a 400 Bad Request if you omit the x-csrf-protection header
						 }

// config
app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');
app.use(express.static(__dirname + '/public'));

// middleware
app.use(bodyParser());
app.use(cookieParser('ftm rules !!'));
app.use(session());

app.use(function(req, res, next){
	var err = req.session.error, msg = req.session.success;
	delete req.session.error;
	delete req.session.success;
	res.locals.message = '';
	if (err) res.locals.message = err ;
	if (msg) res.locals.message =  msg ;
	next();
});

app.use(function(req, res, next) {
  res.locals.user = req.session.user;
  next();
});

function restrict(req, res, next) {
	if (req.session.user) {
		next();
	} else {
		req.session.error = 'Access denied!';
		res.redirect('/login');
	}
}
// validation
String.prototype.isAlphaNumeric = function() {
  var regExp = /^[A-Za-z0-9]+$/;
  return this.match(regExp);
};

// invokes the BlueMix Service's REST API to create a DDA Account
function createDDAAccount(owner, name, number, type, balance, fn) {
	var client = new Client(serviceBrokerRequestParameters);
	var args = {
		headers: DDA_POST_HEADERS,
		data:  '{' +
			  '"owner": "' + owner + '", ' +
	          '"number": "' + number + '", ' +
			  '"name": "' + name + '", ' +
			  '"type": "' + type + '", ' +
			  '"status": "' + 'OPEN' + '", ' +
			  '"balance": "' + balance + '"' +
			   '}'
			};
	console.log("POST Customer");
	var createDDAAccountRequest = client.post(ddaBaseUrl + 'Accounts/', args, function (data, response) {
		if( response.statusCode == 200 ) {
			return fn(null, args.data);
		} else {
			console.log(response.statusCode + ':' + response.statusMessage);
			return fn(response.statusMessage, null);
		}
	});
    createDDAAccountRequest.on('error', function (err) {
		console.log('something went wrong on POST Account', err.request.options);
		console.log(err);
		return fn(err, null);
	});
}

// invokes the BlueMix Service's REST API to lookup a DDA Customer
function listDDAAccounts(id, fn) {
	var client = new Client(serviceBrokerRequestParameters);
	var args = {
		headers: GET_HEADERS
	};
	console.log("GET Accounts");
	var readDDAAccountsRequest = client.get(ddaBaseUrl + 'Accounts/?filter={"where":{"owner":"' + id + '"}}', args, function (data, response) {
		if( response.statusCode == 200 ) {
			return fn(null, data);
		} else {
			console.log(response.statusCode + ':' + response.statusMessage);
			return fn(response.statusMessage, null);
		}
	});
    readDDAAccountsRequest.on('error', function (err) {
		console.log('something went wrong on GET Accounts', err.request.options);
		console.log(err);
		return fn(err,null);
	});
}

// returns the (open) account matching the specified number and user
function findAccount(number, user) {
	var account = null;
	if( user && user.accounts ) {
		for (var i = 0; i < user.accounts.length; i++) {
			if ( user.accounts[i].number == number &&
				 user.accounts[i].status == 'OPEN' ) {
				account = user.accounts[i];
				break;
			}
		}
	}
	return account;
}

// creates a user name that is unique accross a shared instance of FTM
function makeUniqueUsername(username) {
	var s = username;
	if( appEnv && appEnv.app && appEnv.app.application_id ) {
		s = s + ":" + appEnv.app.application_id;
	}
	return sh.unique(s);
}

// creates a user for the sample application
function createLocalUser(username, password, fname, lname, fn) {
	var unique = makeUniqueUsername(username);
	var p = passwordHash.generate(password);
	console.log('creating local user ' + username + '(' + unique + ')');
	createDDACustomer(username, p, unique, fname, lname, function(err, ddaUser) {
		var prefix = generateAccountNumberPrefix(username);
		// create and fund a couple of accounts
		createDDAAccount(unique, 'mySavings', prefix + 2, 'S', 10000, function(err, account) {
			createDDAAccount(unique, 'myChecking', prefix + 1, 'C', 10000, function(err, account) {
				return fn(err, ddaUser);
			});
		});
	});
}

// invokes the BlueMix Service's REST API to create a DDA Customer
function createDDACustomer(username, password, id, fname, lname, fn) {
	var client = new Client(serviceBrokerRequestParameters);
	var args = {
		headers: DDA_POST_HEADERS,
		data:  '{' +
			  '"name": "' + fname + ' ' + lname + '", ' +
	          '"username": "' + username + '", ' +
			  '"fname": "' + fname + '", ' +
			  '"lname": "' + lname + '", ' +
			  '"id": "' + id + '", ' +
			  '"password": "' + password + '"' +
			   '}'
			};
	console.log("POST Customer");
	var createDDACustomerRequest = client.post(ddaBaseUrl + 'Customers/', args, function (data, response) {
		if( response.statusCode == 200 ) {
			return fn(null, args.data);
		} else {
			console.log(response.statusCode + ':' + response.statusMessage);
			return fn(response.statusMessage, null);
		}
	});
    createDDACustomerRequest.on('error', function (err) {
		console.log('something went wrong on POST Customer', err.request.options);
		console.log(err);
		return fn(err, null);
	});
}

// invokes the BlueMix Service's REST API to lookup a DDA Customer
function lookupDDACustomer(id, fn) {
	var client = new Client(serviceBrokerRequestParameters);
	var args = {
		headers: GET_HEADERS
	};
	console.log("GET Customer");
	var readDDACustomer = client.get(ddaBaseUrl + 'Customers/' + id, args, function (data, response) {
		if( response.statusCode == 200 ) {
			return fn(null, data);
		} else {
			console.log(response.statusCode + ':' + response.statusMessage);
			return fn(response.statusMessage, null);
		}
	});
    readDDACustomer.on('error', function (err) {
		console.log('something went wrong on GET Customer', err.request.options);
		console.log(err);
		return fn(err,null);
	});
}

// helps generate a psudo-unique account number
function generateAccountNumberPrefix(username) {
	var s = username;
	if( appEnv && appEnv.app && appEnv.app.application_id ) {
		s = s + ":" + appEnv.app.application_id;
	}
	var hash = 5381;
	var i = s.length || 0;
	while(i) {
		hash = (hash * 33) ^ s.charCodeAt(--i);
	}
	var number = hash >>> 0;
	return number * 10;
}

// figures out if the specified token is an email address or mobile number
function getTokenType(token) {
	var tokenType = 'M';
	if( token && token.indexOf('@') >= 0 )
	{
		tokenType = 'E';
	}
	return tokenType;
}

// builds the compound CXCToken key
function makeCXCTokenKey( partnerID,
						  partnerType,
						  participantID,
						  token,
						  paymentProfileID ) {
		return  partnerID + ":" +
				partnerType + ":" +
				participantID + ":" +
				token + ":" +
				paymentProfileID ;
}

// builds the compound CXCRecipient key
function makeCXCRecipientKey( partnerID,
							  partnerType,
							  token,
							  fname,
							  lname) {
		return  partnerID + ":" +
				partnerType + ":" +
				token + ":" +
				fname + ":" +
				lname ;
}

// builds the compound CXCPayment key
function makeCXCPaymentKey( partnerID,
							partnerType,
							paymentID) {
		return  partnerID + ":" +
				partnerType + ":" +
				paymentID ;
}

// builds the compound CXCPaymentRequest key
function makeCXCPaymentRequestKey( partnerID,
								   partnerType,
								   paymentRequestID) {
		return  partnerID + ":" +
				partnerType + ":" +
				paymentRequestID ;
}

// returns an ISO 8601 date 30 seconds in the future
function makeExpirationTime()
{
	//e.g. 2000-01-23T04:56:07.000Z
	var expirationTime = new Date();
	expirationTime.setTime(expirationTime.getTime() + (30 * 1000));
	return expirationTime.toISOString();
}

// returns an ISO 8601 date now
function makeInitiationDate()
{
	//e.g. 2000-01-23T04:56:07.000Z
	var initiationDate = new Date();
	return initiationDate.toISOString();
}

// returns an ISO 8601 date one hour in the future
function makeDueDate()
{
	//e.g. 2000-01-23T04:56:07.000Z
	var dueDate = new Date();
	dueDate.setTime(dueDate.getTime() + (60 * 60 * 1000));
	return dueDate.toISOString();
}

// invokes FTM's REST API to create a CXCParticipant
function createCXCParticipant(username, fname, lname, fn) {
	var client = new Client(serviceBrokerRequestParameters);
	var args = {
		headers: FTM_POST_HEADERS,
		data:  '{' +
			  '"auditSource": "' + APPLICATION_NAME + '", ' +
	          '"organizationID": "' + ORGANIZATION_ID + '", ' +
			  '"participantID": "' + username + '", ' +
			  '"participantName": "' + fname + ' ' + lname + '", ' +
			  '"partnerID": "' + username + '", ' +
			  '"partnerType": "' + PARTNER_TYPE + '", ' +
			  '"status": "A"' +
			   '}'
			};
	console.log('creating CXCParticipant ' + username);
	console.log("POST CXCParticipant");
	var createCXCParticipantsRequest = client.post(ftmBaseUrl + 'cxcparticipants/', args, function (data, response) {
		if( response.statusCode == 201 ) {
			return fn(null);
		} else {
			var errorDescription = null;
			if( data ) {
				errorDescription = data.errorDescription;
			}
			console.log(response.statusCode + ':' + response.statusMessage + ' ' +  errorDescription);
			return fn(errorDescription);
		}
	});
    createCXCParticipantsRequest.on('error', function (err) {
		console.log('something went wrong on POST CXCParticipant', err.request.options);
		console.log(err);
		return fn(err);
	});
}

// invokes FTM's REST API to lookup a CXCParticipant
function lookupCXCParticipant(username, fn) {
	var cxcUser = null;
	var client = new Client(serviceBrokerRequestParameters);
	var args = {
		headers: GET_HEADERS
	};
	console.log("GET CXCParticipant");
	var readCXCParticipantsRequest = client.get(ftmBaseUrl + 'cxcparticipants/?participantID=' + username, args, function (data, response) {
		if( data ) {
			for (var i = 0; i < data.length; i++) {
				if (data[i].participantID == username) {
					cxcUser = data[i];
					break;
				}
			}
		}
		return fn(null,cxcUser);
	});
    readCXCParticipantsRequest.on('error', function (err) {
		console.log('something went wrong on GET CXCParticipant', err.request.options);
		console.log(err);
		return fn(err,null);
	});
}

// invokes FTM's REST API to list the tokens belonging to a CXCParticipant
function listTokensUsingCXCTokens(username, fn) {
	var err = null;
	var tokens = null;
	var client = new Client(serviceBrokerRequestParameters);
	var args = {
		headers: GET_HEADERS
	};
	console.log("GET CXCToken");
	var readCXCTokensRequest = client.get(ftmBaseUrl + 'cxctokens/?' +
														'partnerID=' + username  + '&' +
														'partnerType=' + PARTNER_TYPE,
													args,
													function (tokens, response) {
		if( response.statusCode != 200 ) {
			if(tokens.errorDescription) {
				err = tokens.errorDescription;
			} else {
				err = 'something went wrong on GET CXCToken.';
			}
		}
		return fn(err,tokens);
	});
    readCXCTokensRequest.on('error', function (err) {
		console.log('something went wrong on GET CXCToken.', err.request.options);
		console.log(err);
		return fn(err,null);
	});
}

// invokes FTM's REST API to look up a CXCToken, using token as a search criteria
function lookupToken(t, username, fn) {
	var token = null;
	var client = new Client(serviceBrokerRequestParameters);
	var args = {
		headers: GET_HEADERS
	};
	console.log("GET CXCToken");
	var readCXCTokensRequest = client.get(ftmBaseUrl + 'cxctokens/?token=' + t +
											'&participantID=' + username +
											'&partnerID=' + username +
											'&partnerType=' + PARTNER_TYPE,
										  args,
										  function (tokens, response) {
		if (tokens && tokens.length > 0) {
			token = tokens[0];
		}
		return fn(null,token);
	});
    readCXCTokensRequest.on('error', function (err) {
		console.log('something went wrong on GET CXCToken.', err.request.options);
		console.log(err);
		return fn(err,null);
	});
}

// invokes FTM's REST API to look up a CXCToken, using account number as a search criteria
function lookupTokenByAccountNumber(number, username, fn) {
	var token = null;
	var client = new Client(serviceBrokerRequestParameters);
	var args = {
		headers: GET_HEADERS
	};
	console.log("GET CXCToken");
	var readCXCTokensRequest = client.get(ftmBaseUrl + 'cxctokens/?accountNumber=' + number +
											'&accountBankCode=' + BANK_CODE +
											'&participantID=' + username +
											'&partnerID=' + username +
											'&partnerType=' + PARTNER_TYPE,
										  args,
										  function (tokens, response) {
		if (tokens && tokens.length > 0) {
			token = tokens[0];
		}
		return fn(null,token);
	});
    readCXCTokensRequest.on('error', function (err) {
		console.log('something went wrong on GET CXCToken.', err.request.options);
		console.log(err);
		return fn(err,null);
	});
}

// invokes FTM's REST API to create a CXCToken
function createCXCToken(number, user, token, fn) {
	var account = findAccount(number, user);
	var tokenType = getTokenType(token);

	if( account && user ){
		var client = new Client(serviceBrokerRequestParameters);
		var args = {
			headers: FTM_POST_HEADERS,
			data:  '{' +
				  '"organizationID": "' + ORGANIZATION_ID + '", ' +
				  '"participantID": "' + user.id + '", ' +
				  '"partnerID": "' + user.id + '", ' +
				  '"partnerType": "' + PARTNER_TYPE + '", ' +
				  '"accountBankCode": "' + BANK_CODE + '", ' +
				  '"accountNumber": "' + account.number + '", ' +
				  '"accountType": "' + account.type + '", ' +
				  '"auditSource": "' + APPLICATION_NAME + '", ' +
				  '"paymentProfileStatus": "A", ' +
				  '"paymentProfileID": "' + GENERATED + '", ' +
				  '"token": "' + token + '", ' +
				  '"tokenStatus": "A", ' +
				  '"tokenType": "' + tokenType + '", ' +
				  '"firstName": "' + user.fname + '", ' +
				  '"lastName": "' + user.lname + '"' +
				   '}'
				};
		console.log('creating CXCToken ' + token);
		console.log("POST CXCToken");
		var createCXCTokenRequest = client.post(ftmBaseUrl + 'cxctokens/', args, function (data, response) {
			if( response.statusCode == 201 ) {
				return fn(null);
			} else {
				var errorDescription = null;
				if( data ) {
					errorDescription = data.errorDescription;
				}
				console.log(response.statusCode + ':' + response.statusMessage + ' ' +  errorDescription);
				return fn(errorDescription);
			}
		});
		createCXCTokenRequest.on('error', function (err) {
			console.log('something went wrong on POST CXCToken', err.request.options);
			console.log(err);
			return fn(err);
		});
	} else {
		err = 'please specify an account number and user name';
		console.log(err);
		return fn(err);
	}
}

// invokes FTM's REST API to edit a CXCToken
function editCXCToken(number, user, token, fn) {
	var account = findAccount(number, user);
	var tokenType = getTokenType(token);

	lookupToken(token, user.id, function(err, cxcToken) {
		if(cxcToken && account) {
			var key = makeCXCTokenKey(cxcToken.partnerID,
									  cxcToken.partnerType,
									  cxcToken.participantID,
									  cxcToken.token,
									  cxcToken.paymentProfileID);
			var client = new Client(serviceBrokerRequestParameters);
			var args = {
				headers: FTM_POST_HEADERS,
				data:  '{' +
					  '"accountBankCode": "' + BANK_CODE + '", ' +
					  '"accountNumber": "' + account.number + '", ' +
					  '"accountType": "' + account.type + '", ' +
					  '"auditSource": "' + APPLICATION_NAME + '", ' +
					  '"paymentProfileStatus": "' + cxcToken.paymentProfileStatus + '", ' +
					  '"tokenStatus": "' + cxcToken.tokenStatus + '", ' +
					  '"tokenType": "' + tokenType + '"' +
					   '}'
					};
			console.log("PUT CXCToken");
			var updateCXCTokenRequest = client.put(ftmBaseUrl + 'cxctokens/' + key, args, function (data, response) {
				if( response.statusCode == 200 ) {
					return fn(null);
				} else {
					var errorDescription = null;
					if( data ) {
						errorDescription = data.errorDescription;
					}
					console.log(response.statusCode + ':' + response.statusMessage + ' ' +  errorDescription);
					return fn(errorDescription);
				}
			});
			updateCXCTokenRequest.on('error', function (err) {
				console.log('something went wrong on PUT CXCToken', err.request.options);
				console.log(err);
				return fn(err);
			});
		} else {
			err = 'please specify a valid account number, user and token';
			console.log(err);
			return fn(err);
		}
	});
}

// invokes FTM's REST API to delete a CXCToken
function deleteCXCToken(token, id, fn) {
	lookupToken(token, id, function(err, cxcToken) {
		if( cxcToken ) {
			var key = makeCXCTokenKey(cxcToken.partnerID,
									  cxcToken.partnerType,
									  cxcToken.participantID,
									  cxcToken.token,
									  cxcToken.paymentProfileID );
			var client = new Client(serviceBrokerRequestParameters);
			var args = {
				headers: FTM_POST_HEADERS
					};
			console.log("DELETE CXCToken");
			var deleteCXCTokenRequest = client.delete(ftmBaseUrl + 'cxctokens/' + key, args, function (data, response) {
				if( response.statusCode == 200 ) {
					return fn(null);
				} else {
					var errorDescription = null;
					if( data ) {
						errorDescription = data.errorDescription;
					}
					console.log(response.statusCode + ':' + response.statusMessage + ' ' +  errorDescription);
					return fn(errorDescription);
				}
			});
			deleteCXCTokenRequest.on('error', function (err) {
				console.log('something went wrong on DELETE CXCToken', err.request.options);
				console.log(err);
				return fn(err);
			});
		} else {
			err = 'please specify a valid user and token';
			console.log(err);
			return fn(err);
		}
	});
}

// invokes FTM's REST API to list the recipients belonging to a CXCParticipant
function listRecipientsUsingCXCRecipients(username, fn) {
	var err = null;
	var recipients = null;
	var client = new Client(serviceBrokerRequestParameters);
	var args = {
		headers: GET_HEADERS
	};
	console.log("GET CXCRecipient");
	var readCXCRecipientsRequest = client.get(ftmBaseUrl + 'cxcrecipients/?' +
														'partnerID=' + username  + '&' +
														'partnerType=' + PARTNER_TYPE,
													args,
													function (recipients, response) {
		if( response.statusCode != 200 ) {
			if(recipients.errorDescription) {
				err = recipients.errorDescription;
			} else {
				err = 'something went wrong on GET CXCRecipient.';
			}
		}
		return fn(err,recipients);
	});
    readCXCRecipientsRequest.on('error', function (err) {
		console.log('something went wrong on GET CXCRecipient.', err.request.options);
		console.log(err);
		return fn(err,null);
	});
}

// invokes FTM's REST API to look up a CXCRecipient
function getRecipient(token, fname, lname, username, fn) {
	var client = new Client(serviceBrokerRequestParameters);
	var args = {
		headers: GET_HEADERS
	};
	if( username ) {
		var key = makeCXCRecipientKey(username,
									  PARTNER_TYPE,
									  token,
									  fname,
									  lname);
		console.log("GET CXCRecipient");
		var readCXCRecipientsRequest = client.get(ftmBaseUrl + 'cxcrecipients/' + key,
											  args,
											  function (recipient, response) {
			return fn(null,recipient);
		});
		readCXCRecipientsRequest.on('error', function (err) {
			console.log('something went wrong on GET CXCRecipient.', err.request.options);
			console.log(err);
			return fn(err,null);
		});
	} else {
		err = 'please specify a valid user';
		console.log(err);
		return fn(err);
	}
}

// invokes FTM's REST API to create a CXCRecipient
function createCXCRecipient(token, fname, lname, username, fn) {
	if( username ) {
		var tokenType = getTokenType(token);

		var client = new Client(serviceBrokerRequestParameters);
		var args = {
			headers: FTM_POST_HEADERS,
			data:  '{' +
				  // Mandatory
				  '"auditSource": "' + APPLICATION_NAME + '", ' +
				  '"currentRecipientFirstName": "' + fname + '", ' +
				  '"currentRecipientLastName": "' + lname + '", ' +
				  '"partnerID": "' + username + '", ' +
				  '"partnerType": "' + PARTNER_TYPE + '", ' +
				  '"token": "' + token + '", ' +
				  '"tokenType": "' + tokenType + '", ' +

				  // Optional
				  '"activateIfExists": "Y", ' +
				  '"isDeleted": "N", ' +
				  '"firstName": "' + fname + '", ' +
				  '"lastName": "' + lname + '", ' +
				  '"organizationID": "' + ORGANIZATION_ID + '"' +
				   '}'
				};
		console.log('creating CXCRecipient ' + token + ":" + fname + ":" + lname);
		console.log("POST CXCRecipient");
		var createCXCRecipientRequest = client.post(ftmBaseUrl + 'cxcrecipients/', args, function (data, response) {
			if( response.statusCode == 201 ) {
				return fn(null);
			} else {
				var errorDescription = null;
				if( data ) {
					errorDescription = data.errorDescription;
				}
				console.log(response.statusCode + ':' + response.statusMessage + ' ' +  errorDescription);
				return fn(errorDescription);
			}
		});
		createCXCRecipientRequest.on('error', function (err) {
			console.log('something went wrong on POST CXCRecipient', err.request.options);
			console.log(err);
			return fn(err);
		});
	} else {
		err = 'please specify a valid user';
		console.log(err);
		return fn(err);
	}
}

// invokes FTM's REST API to edit a CXCRecipient
function editCXCRecipient(fname, lname,
						  _token, _fname, _lname,
						  username, fn) {
	getRecipient(_token, _fname, _lname, username, function(err, cxcRecipient) {
		if( cxcRecipient) {
			var key = makeCXCRecipientKey(cxcRecipient.partnerID,
										  cxcRecipient.partnerType,
										  cxcRecipient.token,
										  cxcRecipient.currentRecipientFirstName,
										  cxcRecipient.currentRecipientLastName);
			var first = fname;
			if( first == null ) {
				first = _fname;
			}
			var last = lname;
			if( last == null ) {
				last = _lname;
			}

			var client = new Client(serviceBrokerRequestParameters);
			var args = {
				headers: FTM_POST_HEADERS,
				data:  '{' +
					  // MANDATORY
					  '"auditSource": "' + APPLICATION_NAME + '", ' +
					  '"newRecipientFirstName": "' + first + '", ' +
					  '"newRecipientLastName": "' + last + '", ' +
					  '"tokenGroup": "' + cxcRecipient.tokenGroup + '", ' +

					  // OPTIONAL
					  '"activateIfExists": "Y", ' +
					  '"isDeleted": "N" ' +
					   '}'
					};
			console.log("PUT CXCRecipient");
			var updateCXCRecipientRequest = client.put(ftmBaseUrl + 'cxcrecipients/' + key, args, function (data, response) {
				if( response.statusCode == 200 ) {
					return fn(null);
				} else {
					var errorDescription = null;
					if( data ) {
						errorDescription = data.errorDescription;
					}
					console.log(response.statusCode + ':' + response.statusMessage + ' ' +  errorDescription);
					return fn(errorDescription);
				}
			});
			updateCXCRecipientRequest.on('error', function (err) {
				console.log('something went wrong on PUT CXCRecipient', err.request.options);
				console.log(err);
				return fn(err);
			});
		} else {
			console.log('recipient %s, %s, %s not found', _token, _fname, _lname);
			console.log(err);
			return fn(err);
		}
	});
}

// invokes FTM's REST API to delete a CXCRecipient
function deleteCXCRecipient(token, fname, lname, username, fn) {
	getRecipient(token, fname, lname, username, function(err, cxcRecipient) {
		if( cxcRecipient ) {
			var key = makeCXCRecipientKey(cxcRecipient.partnerID,
										  cxcRecipient.partnerType,
										  cxcRecipient.token,
										  cxcRecipient.currentRecipientFirstName,
										  cxcRecipient.currentRecipientLastName);
			var client = new Client(serviceBrokerRequestParameters);
			var args = {
				headers: FTM_POST_HEADERS
					};
			console.log("DELETE CXCRecipient");
			var deleteCXCRecipientRequest = client.delete(ftmBaseUrl + 'cxcrecipients/' + key, args, function (data, response) {
				if( response.statusCode == 200 ) {
					return fn(null);
				} else {
					var errorDescription = null;
					if( data ) {
						errorDescription = data.errorDescription;
					}
					console.log(response.statusCode + ':' + response.statusMessage + ' ' +  errorDescription);
					return fn(errorDescription);
				}
			});
			deleteCXCRecipientRequest.on('error', function (err) {
				console.log('something went wrong on DELETE CXCRecipient', err.request.options);
				console.log(err);
				return fn(err);
			});
		} else {
			console.log('recipient %s, %s, %s not found', token, fname, lname);
			console.log(err);
			return fn(err);
		}

	});
}

// invokes FTM's REST API to initiate a CXCPayment
function cxcPayment(token, fname, lname, amount, cxcToken, username, fn) {
	if( cxcToken && username )
	{
		var tokenType = getTokenType(token);
		var expirationTime = makeExpirationTime();

		var client = new Client(serviceBrokerRequestParameters);
		var args = {
			headers: FTM_POST_HEADERS,
			data:  '{' +
				  // Mandatory
				  '"amount": "' + amount + '", ' +
				  '"auditSource": "' + APPLICATION_NAME + '", ' +
				  '"participantName": "' + username + '", ' +
				  '"productType": "P", ' +

				  // Optional
				  '"expirationTime": "' + expirationTime + '", ' +
				  '"participantToken": "' + cxcToken.token + '", ' +
				  '"partnerID": "' + cxcToken.partnerID + '", ' +
				  '"partnerType": "' + cxcToken.partnerType + '", ' +
				  '"paymentID": "' + GENERATED + '", ' +
				  '"recipientFirstName": "' + fname + '", ' +
				  '"recipientLastName": "' + lname + '", ' +
				  '"recipientToken": "' + token + '", ' +
				  '"token": "' + token + '", ' +
				  '"tokenType": "' + tokenType + '"' +
				   '}'
				};
		console.log('creating CXCPayment ' + token + ":" + fname + ":" + lname);
		console.log("POST CXCPayment");
		var createCXCPaymentRequest = client.post(ftmBaseUrl + 'cxcpayments/', args, function (data, response) {
			if( response.statusCode == 201 ) {
				return fn(null);
			} else {
				var errorDescription = null;
				if( data ) {
					errorDescription = data.errorDescription;
				}
				console.log(response.statusCode + ':' + response.statusMessage + ' ' +  errorDescription);
				return fn(errorDescription);
			}
		});
		createCXCPaymentRequest.on('error', function (err) {
			console.log('something went wrong on POST CXCPayment', err.request.options);
			console.log(err);
			return fn(err);
		});
	} else {
		err = 'please specify a valid user and token';
		console.log(err);
		return fn(err);
	}
}

// invokes FTM's REST API to retrieve a CXCPayment
function getPayment(paymentID, username, fn) {
	var client = new Client(serviceBrokerRequestParameters);
	var args = {
		headers: GET_HEADERS
	};
	if( username ) {
		var key = makeCXCPaymentKey(username,
									PARTNER_TYPE,
									paymentID);
		console.log("GET CXCPayment");
		var readCXCPaymentsRequest = client.get(ftmBaseUrl + 'cxcpayments/' + key,
											  args,
											  function (payment, response) {
			var err = null;
			var obj = null;
			if( response.statusCode == 200 ) {
				obj = payment;
			} else {
				if(payment.errorDescription) {
					err = payment.errorDescription;
				} else {
					err = 'something went wrong on GET CXCPaymentRequest.';
				}
			}
			return fn(err,obj);
		});
		readCXCPaymentsRequest.on('error', function (err) {
			console.log('something went wrong on GET CXCPayment.', err.request.options);
			console.log(err);
			return fn(err,null);
		});
	} else {
		err = 'please specify a valid paymentID';
		console.log(err);
		return fn(err);
	}
}

// prepares to invoke FTM's REST API to initiate a CXCPayment
function send(token, fname, lname, amount, account, username, fn) {
	// note: not funds check is required here because
	//       (a) FTM will check the funds and debit the account if the payment is successful
	//       (b) the payment could be future dated
	if( username ) {
		console.log("send %s %s %s %s %d %s", token, fname, lname, amount, account, username);
		lookupTokenByAccountNumber(account, username, function(err, cxcToken) {
			cxcPayment(token, fname, lname, amount, cxcToken, username, function(err){
				return fn(err);
			});
		});
	} else {
		err = 'please specify a valid user';
		console.log(err);
		return fn(err);
	}
}

// invokes FTM's REST API to initiate a CXCPaymentrequest
function cxcPaymentRequest(token, fname, lname, amount, cxcToken, fn) {
	if( cxcToken ) {
		var tokenType = getTokenType(token);
		var dueDate = makeDueDate();
		var initiationDate = makeInitiationDate();

		var client = new Client(serviceBrokerRequestParameters);
		var args = {
			headers: FTM_POST_HEADERS,
			data:  '{' +
					  // Mandatory
					  '"amount": "' + amount + '", ' +
					  '"auditSource": "' + APPLICATION_NAME + '", ' +
					  '"initiationDate": "' + initiationDate + '", ' +
					  '"responderName": "' + fname + ' ' + lname + '", ' +
					  '"responderToken": "' + token + '", ' +
					  '"partnerID": "' + cxcToken.partnerID + '", ' +
					  '"partnerType": "' + cxcToken.partnerType + '", ' +
					  '"paymentRequestID": "' + GENERATED + '", ' +
					  '"requestorDetails": ' +
					  '[' +
						  '{' +
									'"businessName": "' + ORGANIZATION_ID + '", ' +
									'"description": "' + "requesting $" + amount + " to be sent to " + token + '", ' +
									'"dueDate": "' + dueDate + '", ' +
									'"firstName": "' + cxcToken.firstName + '", ' +
									'"fullName": "' + cxcToken.firstName + " " + cxcToken.lastName + '", ' +
									'"lastName": "' + cxcToken.lastName + '", ' +
									'"organizationID": "' + ORGANIZATION_ID + '", ' +
									'"paymentProfileID": "' + cxcToken.paymentProfileID + '", ' +
									'"requestorID": "' + GENERATED + '", ' +
									'"token": "' + cxcToken.token + '", ' +
									'"tokenType": "' + tokenType + '"' +
						'}' +
					']' +
				   '}'
				};
		console.log('creating CXCPayment ' + token + ":" + fname + ":" + lname);
		console.log("POST CXCPayment");
		var createCXCPaymentRequest = client.post(ftmBaseUrl + 'cxcpaymentrequests/', args, function (data, response) {
			if( response.statusCode == 201 ) {
				return fn(null);
			} else {
				var errorDescription = null;
				if( data ) {
					errorDescription = data.errorDescription;
				}
				console.log(response.statusCode + ':' + response.statusMessage + ' ' +  errorDescription);
				return fn(errorDescription);
			}
		});
		createCXCPaymentRequest.on('error', function (err) {
			console.log('something went wrong on POST CXCPayment', err.request.options);
			console.log(err);
			return fn(err);
		});
	} else {
		err = 'please specify a valid token';
		console.log(err);
		return fn(err);
	}
}

// invokes FTM's REST API to retrieve a CXCPaymentRequest
function getPaymentRequest(paymentRequestID, username, fn) {
	var client = new Client(serviceBrokerRequestParameters);
	var args = {
		headers: GET_HEADERS
	};
	if( username ) {
		var key = makeCXCPaymentRequestKey(username,
										   PARTNER_TYPE,
										   paymentRequestID);
		console.log("GET CXCPaymentRequest");
		var readCXCPaymentsRequestRequest = client.get(ftmBaseUrl + 'cxcpaymentrequests/' + key,
											  args,
											  function (paymentequest, response) {
			var err = null;
			var obj = null;
			if( response.statusCode == 200 ) {
				obj = paymentequest;
			} else {
				if(paymentequest.errorDescription) {
					err = paymentequest.errorDescription;
				} else {
					err = 'something went wrong on GET CXCPaymentRequest.';
				}
			}
			return fn(err,obj);
		});
		readCXCPaymentsRequestRequest.on('error', function (err) {
			console.log('something went wrong on GET CXCPaymentRequest.', err.request.options);
			console.log(err);
			return fn(err,null);
		});
	} else {
		err = 'please specify a valid paymentRequestID';
		console.log(err);
		return fn(err);
	}
}

// prepares to invoke FTM's REST API to initiate a CXCPaymentRequest
function request(token, fname, lname, amount, account, username, fn) {
	if( username ) {
		console.log("send %s %s %s %s %d %s", token, fname, lname, amount, account, username);
		lookupTokenByAccountNumber(account, username, function(err, cxcToken) {
			cxcPaymentRequest(token, fname, lname, amount, cxcToken, function(err){
				return fn(err);
			});
		});
	} else {
		err = 'please specify a valid user';
		console.log(err);
		return fn(err);
	}
}

// invokes FTM's REST API to list the payments belonging to a CXCParticipant
function listPayments(username, fn) {
	var client = new Client(serviceBrokerRequestParameters);
	var args = {
		headers: GET_HEADERS
	};
	console.log("GET CXCPayment");
	var readCXCPaymentRequest = client.get(ftmBaseUrl + 'cxcpayments/?' +
														'partnerID=' + username  + '&' +
														'partnerType=' + PARTNER_TYPE,
													args,
													function (payments, response) {
		return fn(null,payments);
	});
    readCXCPaymentRequest.on('error', function (err) {
		console.log('something went wrong on GET CXCPayment.', err.request.options);
		console.log(err);
		return fn(err,null);
	});
}

// invokes FTM's REST API to list the payment requests belonging to a CXCParticipant
function listPaymentRequests(username, fn) {
	var client = new Client(serviceBrokerRequestParameters);
	var args = {
		headers: GET_HEADERS
	};
	console.log("GET CXCPaymentRequest");
	var readCXCPaymentRequestsRequest = client.get(ftmBaseUrl + 'cxcpaymentrequests/?' +
														'partnerID=' + username  + '&' +
														'partnerType=' + PARTNER_TYPE,
													args,
													function (paymentrequests, response) {
		return fn(null,paymentrequests);
	});
    readCXCPaymentRequestsRequest.on('error', function (err) {
		console.log('something went wrong on GET CXCPaymentRequest.', err.request.options);
		console.log(err);
		return fn(err,null);
	});
}

// registers a new sample application user and if necessary creates a new CXCParticipant
function register(req, cXcUser, fn) {
	if( req && req.body ) {
		var username = req.body.username;
		var password = req.body.password;
		var fname = req.body.fname;
		var lname = req.body.lname;

		if(cXcUser)	{
			authenticate(username, password, function(err, user) {
				if(user) {
					return fn(null, user);
				} else {
					console.log('%s doesn\'t seem to exist locally, registering now', username);
					createLocalUser(username, password, fname, lname, function(err, user) {
						return fn(null, user);
					});
				}
			});
		} else {
			console.log('%s doesn\'t seem to exist at all, registering now', username);
			authenticate(username, password, function(err, user) {
				createCXCParticipant(makeUniqueUsername(username), fname, lname, function(err) {
					if(!user && !err) {
						createLocalUser(username, password, fname, lname, function(err, user) {
							return fn(null, user);
						});
					} else {
						return fn(err,user);
					}
				});
			});
		}
	} else {
		return fn('please specify a username, password, first and last name', null);
	}
}

// registers a new sample application user redirects to the next view
function registerAndRedirect(req, res, cXcUser) {
	register(req, cXcUser, function(err, user) {
		if( err) {
			req.session.error = err;
			res.redirect('register');
		} else{
			authenticate(req.body.username, req.body.password, function(err, user){
				loginRedirect(req, res, user);
			});
		}
	});
}

// logs a sample application user in and redirects to the accounts view
function loginRedirect(req, res, user) {
	if (user) {
		// Regenerate session when signing in  to prevent fixation
		req.session.regenerate(function() {
			req.session.user = user;
			res.redirect('accounts');
		});
	} else {
		req.session.error = 'Authentication failed, please check your username and password.';
		res.redirect('login');
	}
}

// authenticates a sample application user
function authenticate(username, password, fn) {
	if (!module.parent) console.log('authenticating %s', username);
	lookupDDACustomer(makeUniqueUsername(username), function(err, user){
		if (!user) return fn('cannot find user');
		if(passwordHash.verify(password, user.password)) {
			return fn(null, user);
		} else {
			console.log('invalid password')
			fn('invalid password');
		}
	});
}

// Routes
app.get('/', function(req, res){
	res.redirect('login');
});

app.get('/accounts', restrict, function(req, res){
	res.locals.section = '1';
	res.locals.title = 'Accounts';
	listDDAAccounts(req.session.user.id, function(err, myAccounts) {
		req.session.user.accounts = myAccounts;
		res.render('accounts');
	});
});

app.get('/tokens', restrict, function(req, res){
	res.locals.section = '1';
	res.locals.title = 'Tokens';

	listTokensUsingCXCTokens(req.session.user.id, function(err, myTokens){
		req.session.user.tokens = myTokens;
		res.render('tokens');
	});
});

app.get('/newtoken', restrict, function(req, res){
	res.locals.section = '1';
	res.locals.title = 'Tokens';
	res.render('newtoken');
});

app.get('/viewtoken', restrict, function(req, res){
	res.locals.section = '1';
	res.locals.title = 'Tokens';
	res.locals.user.token = req.query.token;
	res.render('viewtoken');
});

app.get('/edittoken', restrict, function(req, res){
	res.locals.section = '1';
	res.locals.title = 'Tokens';
	res.locals.user.token = req.query.token;
	res.render('edittoken');
});

app.post('/newtoken', restrict, function(req, res){
	console.log('POST newtoken %s:%s:%s', req.body.legal, req.body.contact, req.body.account);
	if(req.body.legal) {
		createCXCToken(req.body.account, req.session.user, req.body.contact, function(err) {
			req.session.error = err;
			res.redirect('tokens');
		});
	} else {
		req.session.error = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.';
		console.log(req.session.error);
		res.redirect('newtoken');
	}
});

app.post('/edittoken', restrict, function(req, res){
	console.log('POST edittoken %s:%s:%s', req.body.legal, req.body.contact, req.body.account);
	if(req.body.legal) {
		editCXCToken(req.body.account, req.session.user, req.body.contact, function(err) {
			req.session.error = err;
			res.redirect('tokens');
		});
	} else {
		req.session.error = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.';
		console.log(req.session.error);
		res.redirect('edittoken?token=' + req.body.contact);
	}
});

app.get('/deletetoken', restrict, function(req, res){
	deleteCXCToken(req.query.token, req.session.user.id, function(err) {
			req.session.error = err;
			res.redirect('tokens');
		});
});

app.get('/recipients', restrict, function(req, res){
	res.locals.section = '1';
	res.locals.title = 'Recipients';

	listRecipientsUsingCXCRecipients(req.session.user.id, function(err, myRecipients){
		req.session.user.recipients = myRecipients;
		res.render('recipients');
	});
});

app.get('/newrecipient', restrict, function(req, res){
	res.locals.section = '1';
	res.locals.title = 'Recipients';
	res.render('newrecipient');
});

app.get('/viewrecipient', restrict, function(req, res){
	res.locals.section = '1';
	res.locals.title = 'Recipients';
	res.locals.user.token = req.query.token;
	res.locals.user.fname = req.query.fname;
	res.locals.user.lname = req.query.lname;
	res.render('viewrecipient');
});

app.get('/editrecipient', restrict, function(req, res){
	res.locals.section = '1';
	res.locals.title = 'Recipients';
	res.locals.user.token = req.query.token;
	res.render('editrecipient');
});

app.post('/newrecipient', restrict, function(req, res){
	console.log('POST newrecipient %s:%s:%s', req.body.token, req.body.fname, req.body.lname);
	createCXCRecipient(req.body.token, req.body.fname, req.body.lname, req.session.user.id, function(err) {
		req.session.error = err;
		res.redirect('recipients');
	});
});

app.post('/editrecipient', restrict, function(req, res){
	console.log('POST editrecpient %s:%s:%s', req.body.token, req.body.fname, req.body.lname);
	editCXCRecipient(req.body.fname, req.body.lname, req.body._token, req.body._fname, req.body._lname,
					 req.session.user.id, function(err) {
		req.session.error = err;
		res.redirect('recipients');
	});
});

app.get('/deleterecipient', restrict, function(req, res){
	deleteCXCRecipient(req.query.token, req.query.fname, req.query.lname, req.session.user.id, function(err) {
			req.session.error = err;
			res.redirect('recipients');
		});
});

app.get('/send', restrict, function(req, res){
	res.locals.section = '2';
	res.locals.title = 'Send';

	listTokensUsingCXCTokens(req.session.user.id, function(err, myTokens){
		req.session.user.tokens = myTokens;
		listRecipientsUsingCXCRecipients(req.session.user.id, function(err, myRecipients){
			req.session.user.recipients = myRecipients;
			res.render('send');
		});
	});
});

app.get('/send2', restrict, function(req, res){
	res.locals.section = '2';
	res.locals.title = 'Send';
	res.locals.user.token = req.query.token;
	res.locals.user.fname = req.query.fname;
	res.locals.user.lname = req.query.lname;
	listTokensUsingCXCTokens(req.session.user.id, function(err, myTokens){
		req.session.user.tokens = myTokens;
		res.render('send2');
	});
});

app.post('/send', restrict, function(req, res){
	console.log('POST send %s:%s:%s', req.body.token, req.body.fname, req.body.lname, req.body.amount, req.body.account);
	send(req.body.token, req.body.fname, req.body.lname, req.body.amount, req.body.account, req.session.user.id, function(err) {
		req.session.error = err;
		if(err){
			res.redirect('send2?token=' + req.body.token + '&fname=' + req.body.fname +'&lname=' + req.body.lname);
		}
		else{
			res.redirect('activity');
		}
	});
});

app.get('/request', restrict, function(req, res){
	res.locals.section = '3';
	res.locals.title = 'Request';

	listTokensUsingCXCTokens(req.session.user.id, function(err, myTokens){
		req.session.user.tokens = myTokens;
		listRecipientsUsingCXCRecipients(req.session.user.id, function(err, myRecipients){
			req.session.user.recipients = myRecipients;
			res.render('request');
		});
	});
});

app.get('/request2', restrict, function(req, res){
	res.locals.section = '3';
	res.locals.title = 'Request';
	res.locals.user.token = req.query.token;
	res.locals.user.fname = req.query.fname;
	res.locals.user.lname = req.query.lname;
	listTokensUsingCXCTokens(req.session.user.id, function(err, myTokens){
		req.session.user.tokens = myTokens;
		res.render('request2');
	});
});

app.post('/request', restrict, function(req, res){
	console.log('POST request %s:%s:%s:%d', req.body.token, req.body.fname, req.body.lname, req.body.amount, req.body.account);
	if( !req.body.amount ||  req.body.amount == 0 ) {
		req.session.error = 'Please enter a non-zero amount';
		res.redirect('request2?token=' + req.body.token + '&fname=' + req.body.fname +'&lname=' + req.body.lname);
	} else {
		request(req.body.token, req.body.fname, req.body.lname, req.body.amount, req.body.account, req.session.user.id, function(err) {
			req.session.error = err;
			if(err){
				res.redirect('request2?token=' + req.body.token + '&fname=' + req.body.fname +'&lname=' + req.body.lname);
			}
			else{
				res.redirect('activity');
			}
		});
	}
});

app.get('/activity', restrict, function(req, res){
	res.locals.section = '4';
	res.locals.title = 'Activity';

	listPaymentRequests(req.session.user.id, function(err, myPaymentRequests){
		req.session.user.paymentrequests = myPaymentRequests;
		listPayments(req.session.user.id, function(err, myPayments){
			listTokensUsingCXCTokens(req.session.user.id, function(err, myTokens) {
				req.session.user.tokens = myTokens;
				req.session.user.payments = myPayments;
				res.render('activity');
			});
		});
	});
});

app.get('/viewpayment', restrict, function(req, res){
	res.locals.section = '4';
	res.locals.title = 'Activity';

	var payment;
	getPayment(req.query.paymentID, req.session.user.id, function(err, payment) {
		req.session.user.payment = payment;
		if(payment) {
		  res.render('viewpayment');
		} else {
		   res.redirect('activity');
		}
	});
});

app.get('/viewpaymentrequest', restrict, function(req, res){
	res.locals.section = '4';
	res.locals.title = 'Activity';

	listTokensUsingCXCTokens(req.session.user.id, function(err, myTokens) {
		res.locals.user.tokens = myTokens;
		var paymentrequest;
		getPaymentRequest(req.query.paymentRequestID, req.session.user.id, function(err, paymentrequest) {
		   req.session.user.paymentrequest = paymentrequest;
		   if(paymentrequest) {
			  res.render('viewpaymentrequest');
		   } else {
			   res.redirect('activity');
		   }
		});
	});
});

app.get('/register', function(req, res){
	res.locals.title = 'Register';
	res.render('register');
});

app.post('/register', function(req, res){
	if( !req.body.username || !req.body.password || !req.body.fname || !req.body.lname ||
		!req.body.username.isAlphaNumeric() || !req.body.fname.isAlphaNumeric() || !req.body.lname.isAlphaNumeric() ) {
		req.session.error = 'Please specify an alpha numeric username, first and last name, and a password too.';
		res.redirect('register');
	} else {
		var id = makeUniqueUsername(req.body.username);
		lookupCXCParticipant(id, function(err, cXcUser)	{
		if(cXcUser) {
			lookupDDACustomer(id, function(err, user) {
				if(user) {
					req.session.error = user.username + ' is already registered.';
					res.redirect('login');
				} else {
					registerAndRedirect(req, res, cXcUser);
				}
			});
		} else {
			registerAndRedirect(req, res, null);
		}
	});
	}
});

app.get('/logout', function(req, res){
	// destroy the user's session to log them out will be re-created next request
	req.session.destroy(function(){
		res.redirect('/login');
	});
});

app.get('/login', function(req, res){
	console.log(req.connection.remoteAddress);
	res.locals.title = 'Login';
	res.render('login');
});

app.post('/login', function(req, res){
	authenticate(req.body.username, req.body.password, function(err, user){
		loginRedirect(req, res, user);
	});
});

// launches a server and listens for incoming HTTP requests
app.listen(port);
console.log('Express started on port ' + port);
