
KARMA=node_modules/.bin/karma 
ESLINT=node_modules/.bin/eslint 
WEBPACK=node_modules/.bin/webpack
SOURCES=$(shell find src -name "*.js")

.PHONY: dist

dist: $(SOURCES)
	cp $(SOURCES) dist

test: $(KARMA) karma.conf.js
	$(KARMA) start karma.conf.js

node_modules: package.json
	npm install



