version:
	@target="$(word 2,$(MAKECMDGOALS))"; \
	if [ -z "$$target" ]; then \
		current=$$(perl -ne 'print $$1 if /"version": "([^"]*)"/' manifest.json); \
		target=$$(echo "$$current" | awk -F. '{ print $$1 "." $$2 + 1 }'); \
	fi; \
	if ! echo "$$target" | grep -Eq '^[0-9]+\.[0-9]+$$'; then \
		echo "Usage: make version [x.y]"; \
		exit 1; \
	fi; \
	perl -pi -e "s/\"version\": \"[^\"]*\"/\"version\": \"$$target\"/" package.json manifest.json; \
	echo "🔖 version set to $$target"

%:
	@:

lint:
	npm run lint:fix

build: lint
	npm run build

build-dev: lint
	npm run build:dev

zip: build
	cd dist && zip -r ../extension.zip .
	@size=$$(du -k extension.zip | cut -f1); echo "📦 extension.zip — $${size} KB"

remove-zip:
	rm -f extension.zip

cdn: build
	aws s3 sync dist/ s3://cdn/extension/latest/
	@echo "☁️  published dist/ to cdn.vigogh.com/extension/latest/"

cdn-dev: build-dev
	aws s3 sync dist/ s3://cdn/extension/dev/latest/
	@echo "☁️  published dist/ to cdn.vigogh.com/extension/dev/latest/"
