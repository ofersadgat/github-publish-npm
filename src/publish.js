#!/usr/bin/env node

const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const ini = require('ini');
const GitUrlParse = require("git-url-parse");
const GitHubApi = require('github');

var overwriteAssets = false;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
	console.error('You do not have GITHUB_TOKEN set in your environment.');
	process.exit(1);
}

var distPath = path.resolve(process.cwd(), 'dist');
if (!fs.existsSync(distPath)){
	console.error('Dist has not been built.');
	process.exit(1);
}

var distItems = fs.readdirSync(distPath)
	.map(function(item){
		return path.resolve(distPath, item);
	})
	.filter(function(item){
		return fs.statSync(item).isFile();
	});
if (!distItems || distItems.length == 0){
	console.error('No files found in the dist directory.');
	process.exit(1);
}

var packageJsonPath = path.resolve(process.cwd(), 'package.json');
if (!fs.existsSync(packageJsonPath)){
	console.error('Cannot find a package.json.');
	process.exit(1);
}
var packageJson = require(packageJsonPath);

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
	token: GITHUB_TOKEN,
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

var ensureAssets = function(releaseId, releaseItems, callback){

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
			console.error('There was an error trying to list assets for the release ' + packageJson.release + ': ', error);
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
							ensureAssets(releaseId, releaseItems, callback);
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

ensureRelease(packageJson.version, function(releaseId){
	ensureAssets(releaseId, distItems, function(){
		console.log('Successfully uploaded version ', packageJson.version);
	});
});

