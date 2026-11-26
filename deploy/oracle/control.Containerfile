# The control app (lodgiva_control) on top of the Lodgiva base image.
# Built by build_server_image in release.sh; seconds to rebuild.
# It has no Python dependencies, so a .pth entry is exactly what an editable
# install would write, without needing pip in the image.
ARG BASE
FROM ${BASE}
COPY --chown=frappe:0 lodgiva_control /home/frappe/frappe-bench/apps/lodgiva_control
RUN cd /home/frappe/frappe-bench \
 && echo /home/frappe/frappe-bench/apps/lodgiva_control \
      > "$(env/bin/python -c 'import site; print(site.getsitepackages()[0])')/lodgiva_control.pth" \
 && env/bin/python -c "import lodgiva_control"
