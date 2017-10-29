#!/usr/bin/env node

"use strict";

const chalk = require('chalk');
const clear = require('clear');
const CLI = require('clui');
const figlet = require('figlet');
const inquirer = require('inquirer');
const Preferences = require('preferences');
const Spinner = CLI.Spinner;
const GitHubApi = require('github');
const _ = require('lodash');
const git = require('simple-git')();
const touch = require('touch');
const fs = require('fs');
const files = require('./lib/files');

/**
 * Node CLIの初期化
 */
function initialize() {
  clear();
  console.log(
    chalk.yellow(
      figlet.textSync('Ginit', { horizontalLayout: 'full' })
    )
  );
  
  if (files.directoryExists('.git')) {
    console.log(chalk.red('Alreaady a git repository!'));
    process.exit();
  }
}
initialize();

/**
 * GitHub APIのインスタンスを作成
 */
const github = new GitHubApi({
  version: '3.0.0',
  timeout: 5000
});

/**
 * ユーザーに認証情報用のプロンプトを表示する
 * @param {function} callback 
 */
function getGithubCredentials(callback) {
  const questions = [{
    name: 'username',
    type: 'input',
    message: 'Enter your Github username or e-mail address',
    validate: value => {
      if (value.length) {
        return true;
      } else {
        return 'Please enter your username or e-mail address';
      }
    }
  }, {
    name: 'password',
    type: 'password',
    message: 'Enter your password',
    validate: value => {
      if (value.length) {
        return true;
      } else {
        return 'Please enter your password';
      }
    }
  }, {
    name: 'two-factor',
    type: 'input',
    message: 'Enter your 2FA authentication code'
  }];

  inquirer.prompt(questions).then(callback);
}

/**
 * アクセストークンが取得済みかチェックする
 * @param {function} callback 
 */
function getGithubToken(callback) {
  var prefs = new Preferences('ginit');

  if (prefs.github && prefs.github.token) {
    return callback(null, prefs.github.token);
  }

  getGithubCredentials(function (credentials) {
    // スピナーの作成
    const status = new Spinner('Authenticating you, please wait...');
    status.start();

    // Oauthトークンの取得に入る前に、basic authenticationを使用する
    github.authenticate(
      _.extend(
        {
          type: 'basic',
        },
        credentials
      )
    );

    // アプリケーション用のアクセストークンを作成する
    let authorizationCreateParams = {
      scopes: ['user', 'public_repo', 'repo', 'repo:status'],
      note: 'ginit, the command-line tool for initalizing Git repos'
    };

    if (credentials['two-factor']) {
      authorizationCreateParams.headers = {'X-GitHub-OTP': credentials['two-factor']};
    }

    github.authorization.create(authorizationCreateParams, function (err, res) {
      status.stop();

      if (err) {
        return callback(err);
      }

      // 次回に備えてpreferencesにアクセストークンを設定する
      if (res.data.token) {
        prefs.github = {
          token: res.data.token
        };
        return callback(null, res.data.token);
      }
      return callback();
    });
  });
}

/**
 * リポジトリを作成する
 * @param {function} callback 
 */
function createRepo(callback) {
  const argv = require('minimist')(process.argv.slice(2));

  const questions = [
    {
      type: 'input',
      name: 'name',
      message: 'Enter a name for the repository:',
      default: argv._[0] || files.getCurrentDirectoryBase(),
      validate: function (value) {
        if (value.length) {
          return true;
        } else {
          return 'Please enter a name for the repository';
        }
      }
    },
    {
      type: 'input',
      name: 'description',
      default: argv._[1] || null,
      message: 'Optionally enter a description of the repository:'
    },
    {
      type: 'list',
      name: 'visibility',
      message: 'Public or private:',
      choices: ['public', 'private'],
      default: 'public'
    }
  ];

  inquirer.prompt(questions).then(function (answers) {
    var status = new Spinner('Creating repository...');
    status.start();

    var data = {
      name: answers.name,
      description: answers.description,
      private: (answers.visibility === 'private')
    };

    github.repos.create(
      data,
      function (err, res) {
        status.stop();
        if (err) {
          return callback(err);
        }
        return callback(null, res.data.ssh_url);
      }
    );
  });
}

/**
 * .gitignoreファイルを作成する
 * @param {function} callback 
 */
function createGitignore(callback) {
  var filelist = _.without(fs.readdirSync('.'), '.git', '.gitignore');

  if (filelist.length) {
    inquirer.prompt(
      [
        {
          type: 'checkbox',
          name: 'ignore',
          message: 'Select the files and/or folders you wish to ignore:',
          choices: filelist,
          default: ['node_modules', 'bower_components']
        }
      ]
    ).then(function (answers) {
      if (answers.ignore.length) {
        fs.writeFileSync('.gitignore', answers.ignore.join('\n'));
      } else {
        touch('.gitignore');
      }
      return callback();
    }
      );
  } else {
    touch('.gitignore');
    return callback();
  }
}

function setupRepo(url, callback) {
  var status = new Spinner('Setting up the repository...');
  status.start();

  git
    .init()
    .add('.gitignore')
    .add('./*')
    .commit('Initial commit')
    .addRemote('origin', url)
    .push('origin', 'master')
    .then(function () {
      status.stop();
      return callback();
    });
}

/**
 * トークンを取得してユーザーを認証する
 * @param {function} callback 
 */
function githubAuth(callback) {
  getGithubToken(function (err, token) {
    if (err) {
      return callback(err);
    }
    github.authenticate({
      type: 'oauth',
      token: token
    });
    return callback(null, token);
  });
}

githubAuth(function (err, authed) {
  if (err) {
    console.log(chalk.red(JSON.parse(err.message).message));
    switch (err.code) {
      case 401:
        console.log(chalk.red('Couldn\'t log you in. Please try again.'));
        break;
      case 422:
        console.log(chalk.red('You already have an access token.'));
        break;
    }
  }
  if (authed) {
    console.log(chalk.green('Successfully authenticated!'));
    createRepo(function (err, url) {
      if (err) {
        console.log('An error has occured');
      }
      if (url) {
        createGitignore(function () {
          setupRepo(url, function (err) {
            if (!err) {
              console.log(chalk.green('All done!'));
            }
          });
        });
      }
    });
  }
});