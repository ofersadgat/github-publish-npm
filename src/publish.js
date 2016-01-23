#!/usr/bin/env node

const _             = require('lodash');
const fs            = require('fs');
const path          = require('path');
const ini           = require('ini');
const GitUrlParse   = require("git-url-parse");
const GitHubApi     = require('github');

var program = require('commander');

program
  .version(require('../package.json').version)
  .option('-i, --input [path]', 'The folder / file that you want uploaded [./dist]', path.resolve(process.cwd(), 'dist'))
  .option('-t, --token [token]', 'The GitHub token to use. Will also look for GITHUB_TOKEN environment variable.', process.env.GITHUB_TOKEN)
  .option('-o, --overwrite', 'Will overwrite the existing assets [false]', false)
  .option('-u, --upload-version [version]', 'The version to upload. This will not change the latest in addition to the supplied version')
  .option('-p, --package [path]', 'The path to the package.json. You can use this or the version option, but this will also update "latest" [./package.json]', path.resolve(process.cwd(), 'package.json'))
  .parse(process.argv);

const overwriteAssets = program.overwrite;

if (!program.token) {
	console.error('You do not have GITHUB_TOKEN set in your environment.');
	process.exit(1);
}

if (!fs.existsSync(program.input)){
	console.error('The upload path "' + program.input + '" does not exist.');
	process.exit(1);
}

var items = fs.lstatSync(program.input).isDirectory() ?
	fs.readdirSync(program.input)
		.map(function(item){
			return path.resolve(program.input, item);
		})
		.filter(function(item){
			return fs.statSync(item).isFile();
		}) :
	[program.input];
if (!items || items.length == 0){
	console.error('No files found to upload.');
	process.exit(1);
}

var version = program.uploadVersion || (fs.existsSync(program.package) && require(program.package).version);
if (!version){
	console.error('You did not specify a version to upload.');
	process.exit(1);
}

var gitConfigPath = path.resolve(process.cwd(), '.git', 'config');
if (!fs.existsSync(gitConfigPath)){
	console.error('This does not seem to be a git repo.');
	process.exit(1);
}

var gitConfig = GitUrlParse(ini.parse(fs.readFileSync(gitConfigPath, 'utf-8'))['remote "origin"'].url);
var GitHub_msgBase = {
	owner: gitConfig.owner,
	repo: gitConfig.name,
};

const GitHub = new GitHubApi({
	version: "3.0.0",
	protocol: "https",
	host: gitConfig.resource == 'github.com' ? 'api.github.com' : gitConfig.resource,
});

GitHub.authenticate({
	type: 'token',
	token: program.token,
});

var ensureRelease = function(releaseVersion, callback){
	GitHub.releases.listReleases(GitHub_msgBase, function(error, data){
		if (error){
			console.error('There was an error trying to fetch the current releases: ', error);
			process.exit(1);
		}
		var existing = _.find(data, 'tag_name', releaseVersion);
		if (existing){
			console.error('A release already exists for version ', releaseVersion);
			callback(existing.id);
		} else {
			var release = _.extend({
				tag_name: releaseVersion,
			}, GitHub_msgBase);
			GitHub.releases.createRelease(release, function(error, data){
				if (error){
					console.error('There was an error trying create a release: ', error);
					process.exit(1);
				}
				callback(data.id);
			});
		}
	});
};

var ensureAssets = function(release, releaseId, releaseItems, overwriteAssets, callback){

	var getReleaseItemByBasename = function(releaseItems, name){
		if (name instanceof Array){
			return name.map(function(current){
				return getReleaseItemByBasename(releaseItems, current);
			});
		}
		var result = releaseItems.filter(function(releaseItem){
			return path.basename(releaseItem) == name;
		});
		return result && result[0];
	};

	var GitHub_releaseMsgBase = _.extend({
		id: releaseId,
	}, GitHub_msgBase);

	GitHub.releases.listAssets(GitHub_releaseMsgBase, function(error, data){
		if (error){
			console.error('There was an error trying to list assets for the release ' + release + ': ', error);
			process.exit(1);
		}

		var itemsUploaded = [];
		var itemsToUpload = [];

		var existing = _.intersection(releaseItems.map(function(releaseItem){
			return path.basename(releaseItem);
		}), _.pluck(data, 'name'));

		if (existing.length > 0){
			console.log('Some assets have already been uploaded for this release: ', existing);
			if (overwriteAssets){
				var ids = _.pluck(data.filter(function(item){
						return existing.indexOf(item.name) != -1;
					}), 'id');
				var removed = [];
				ids.forEach(function(id){
					var deleteAsset = _.extend({
						id: id,
					}, GitHub_msgBase);
					GitHub.releases.deleteAsset(deleteAsset, function(error){
						if (error){
							console.error('There was an error trying delete an asset: ', error);
							process.exit(1);
						}
						console.log('Deleted ' + _.find(data, 'id', id).name);
						removed.push(id);
						if (removed.length == ids.length){
							ensureAssets(release, releaseId, releaseItems, overwriteAssets, callback);
						}
					});
				});
				return;
			}
		}

		var different = _.difference(releaseItems.map(function(releaseItem){
			return path.basename(releaseItem);
		}), _.pluck(data, 'name'));
		itemsToUpload = itemsToUpload.concat(getReleaseItemByBasename(releaseItems, different));

		if (itemsToUpload.length === 0){
			callback();
		} else {
			itemsToUpload.forEach(function(item){
				var releaseAsset = _.extend({
					name: path.basename(item),
					filePath: item,
				}, GitHub_releaseMsgBase);
				GitHub.releases.uploadAsset(releaseAsset, function(error, data){
					if (error){
						console.error('There was an error trying upload an asset "' + item + '" : ', error);
						process.exit(1);
					}
					console.log('Uploaded ' + path.basename(item));
					itemsUploaded.push(item);
					if (itemsUploaded.length == itemsToUpload.length){
						callback();
					}
				});
			});
		}
	});
};

console.log('Uploading version ', version);
ensureRelease(version, function(releaseId){
	ensureAssets(version, releaseId, items, overwriteAssets, function(){
		console.log('Successfully uploaded version ', version);
		console.log('Uploading latest...');
		ensureRelease('latest', function(latestReleaseId){
			ensureAssets('latest', latestReleaseId, items, true, function(){
				console.log('Successfully uploaded version ', version, ' as latest.');
			});
		});
	});
});

